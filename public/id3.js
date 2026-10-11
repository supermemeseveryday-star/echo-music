// Minimal tag reader: ID3v2.2/2.3/2.4 (MP3) and MP4/M4A atoms, plus an MP3 duration estimate.
// Works on the first few hundred KB of a file, which is all we download while scanning.
(function () {
  const td = (enc) => { try { return new TextDecoder(enc); } catch { return new TextDecoder('utf-8'); } };

  function decodeText(b) {
    if (!b.length) return '';
    const enc = b[0];
    let body = b.subarray(1);
    let s;
    if (enc === 1 || enc === 2) {
      let le = enc === 1 ? true : false;
      if (enc === 1 && body[0] === 0xfe && body[1] === 0xff) { le = false; body = body.subarray(2); }
      else if (enc === 1 && body[0] === 0xff && body[1] === 0xfe) { body = body.subarray(2); }
      s = td(le ? 'utf-16le' : 'utf-16be').decode(body);
    } else if (enc === 3) s = td('utf-8').decode(body);
    else {
      // ISO-8859-1 per spec, but many Chinese files are really GBK
      try { s = new TextDecoder('utf-8', { fatal: true }).decode(body); }
      catch { s = /[\x80-\xff]/.test(String.fromCharCode(...body.subarray(0, 64))) ? td('gbk').decode(body) : td('latin1').decode(body); }
    }
    return s.replace(/\u0000+$/g, '').split('\u0000')[0].trim();
  }

  function syncsafe(b, o) { return (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3]; }

  function id3(b) {
    if (b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return null; // "ID3"
    const ver = b[3];
    const flags = b[5];
    const size = syncsafe(b, 6) + 10;
    const out = { tagSize: size };
    let p = 10;
    if (flags & 0x40 && ver >= 3) p += ver === 4 ? syncsafe(b, 10) : ((b[10] << 24) | (b[11] << 16) | (b[12] << 8) | b[13]) + 4;
    const idLen = ver === 2 ? 3 : 4;
    const hdr = ver === 2 ? 6 : 10;
    const map = ver === 2
      ? { TT2: 'title', TP1: 'artist', TP2: 'albumArtist', TAL: 'album', TRK: 'track', TYE: 'year', TCO: 'genre', PIC: 'pic' }
      : { TIT2: 'title', TPE1: 'artist', TPE2: 'albumArtist', TALB: 'album', TRCK: 'track', TYER: 'year', TDRC: 'year', TCON: 'genre', APIC: 'pic', TLEN: 'tlen' };
    while (p + hdr < Math.min(size, b.length)) {
      const id = String.fromCharCode(...b.subarray(p, p + idLen));
      if (!/^[A-Z0-9]+$/.test(id)) break;
      const fsize = ver === 2 ? (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5]
        : ver === 4 ? syncsafe(b, p + 4) : ((b[p + 4] << 24) | (b[p + 5] << 16) | (b[p + 6] << 8) | b[p + 7]);
      const start = p + hdr;
      if (fsize <= 0 || start + fsize > b.length) { p = start + Math.max(fsize, 0); if (start + fsize > b.length) break; continue; }
      const data = b.subarray(start, start + fsize);
      const key = map[id];
      if (key === 'pic' && !out.pic) {
        // enc, mime (v2.3+) or 3-char format (v2.2), type, description, image
        let q = 1;
        let mime = 'image/jpeg';
        if (ver === 2) { mime = String.fromCharCode(...data.subarray(1, 4)).toLowerCase() === 'png' ? 'image/png' : 'image/jpeg'; q = 4; }
        else { const e = data.indexOf(0, 1); mime = String.fromCharCode(...data.subarray(1, e)) || mime; q = e + 1; }
        q += 1; // picture type
        const enc = data[0];
        if (enc === 1 || enc === 2) { while (q + 1 < data.length && !(data[q] === 0 && data[q + 1] === 0)) q += 2; q += 2; }
        else { while (q < data.length && data[q] !== 0) q++; q++; }
        if (!mime.includes('/')) mime = `image/${mime.toLowerCase() === 'png' ? 'png' : 'jpeg'}`;
        out.pic = new Blob([data.subarray(q)], { type: mime });
      } else if (key && key !== 'pic' && !out[key]) {
        out[key] = decodeText(data);
      }
      p = start + fsize;
    }
    if (out.track) out.track = parseInt(out.track) || null;
    if (out.year) out.year = parseInt(String(out.year).slice(0, 4)) || null;
    if (out.genre) out.genre = out.genre.replace(/^\((\d+)\)/, '').trim() || null;
    if (out.tlen) out.duration = Number(out.tlen) / 1000;
    return out;
  }

  // MPEG audio frame header -> bitrate, used for a size based duration estimate
  const BR = { 1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] };
  const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  function mp3Duration(b, from, fileSize) {
    for (let i = from; i < Math.min(b.length - 4, from + 64 * 1024); i++) {
      if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
      const ver = (b[i + 1] >> 3) & 3, layer = (b[i + 1] >> 1) & 3, bri = b[i + 2] >> 4, sri = (b[i + 2] >> 2) & 3;
      if (ver === 1 || layer !== 1 || bri === 0 || bri === 15 || sri === 3) continue;
      const sr = SR[ver][sri];
      const spf = ver === 3 ? 1152 : 576;
      // Xing / Info header gives an exact frame count for VBR files
      const side = ver === 3 ? ((b[i + 3] >> 6) === 3 ? 17 : 32) : ((b[i + 3] >> 6) === 3 ? 9 : 17);
      const x = i + 4 + side;
      const tag = String.fromCharCode(b[x], b[x + 1], b[x + 2], b[x + 3]);
      if ((tag === 'Xing' || tag === 'Info') && b[x + 7] & 1) {
        const frames = (b[x + 8] << 24) | (b[x + 9] << 16) | (b[x + 10] << 8) | b[x + 11];
        return (frames * spf) / sr;
      }
      const kbps = BR[ver === 3 ? 1 : 2][bri];
      return ((fileSize - from) * 8) / (kbps * 1000);
    }
    return 0;
  }

  // MP4 / M4A: walk moov > udta > meta > ilst
  function mp4(b) {
    const u32 = (o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
    const name = (o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
    if (name(4) !== 'ftyp') return null;
    const out = {};
    const keys = { '©nam': 'title', '©ART': 'artist', aART: 'albumArtist', '©alb': 'album', '©day': 'year', '©gen': 'genre', trkn: 'track', covr: 'pic' };
    function walk(s, e, depth) {
      let p = s;
      while (p + 8 <= e && p + 8 <= b.length) {
        const size = u32(p), t = name(p + 4);
        if (size < 8) break;
        const end = Math.min(p + size, e);
        if (t === 'mvhd') { const v = b[p + 8]; const ts = v === 1 ? u32(p + 28) : u32(p + 20); const du = v === 1 ? u32(p + 36) : u32(p + 24); if (ts) out.duration = du / ts; }
        if (['moov', 'udta', 'ilst', 'trak', 'mdia'].includes(t)) walk(p + 8, end, depth + 1);
        else if (t === 'meta') walk(p + 12, end, depth + 1);
        else if (keys[t]) {
          const d = p + 8;
          if (name(d + 4) === 'data') {
            const dsize = u32(d), type = u32(d + 8), data = b.subarray(d + 16, Math.min(d + dsize, b.length));
            const k = keys[t];
            if (k === 'pic') out.pic = new Blob([data], { type: type === 14 ? 'image/png' : 'image/jpeg' });
            else if (k === 'track') out.track = (data[2] << 8) | data[3];
            else out[k] = td('utf-8').decode(data);
          }
        }
        if (t === 'mdat') break;
        p += size;
      }
    }
    walk(0, b.length, 0);
    if (out.year) out.year = parseInt(String(out.year).slice(0, 4)) || null;
    return out;
  }

  // FLAC: STREAMINFO for duration, VORBIS_COMMENT for tags, PICTURE for cover
  function flac(b) {
    if (String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'fLaC') return null;
    const out = {};
    let p = 4;
    while (p + 4 < b.length) {
      const last = b[p] & 0x80, type = b[p] & 0x7f, len = (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
      const d = p + 4;
      if (d + len > b.length) break;
      if (type === 0) {
        const sr = (b[d + 10] << 12) | (b[d + 11] << 4) | (b[d + 12] >> 4);
        const total = ((b[d + 13] & 0x0f) * 2 ** 32) + ((b[d + 14] << 24) >>> 0) + (b[d + 15] << 16) + (b[d + 16] << 8) + b[d + 17];
        if (sr) out.duration = total / sr;
      } else if (type === 4) {
        const le = (o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
        let q = d + 4 + le(d);
        const n = le(q); q += 4;
        for (let i = 0; i < n && q < d + len; i++) {
          const l = le(q); const kv = td('utf-8').decode(b.subarray(q + 4, q + 4 + l)); q += 4 + l;
          const eq = kv.indexOf('='); const k = kv.slice(0, eq).toUpperCase(), v = kv.slice(eq + 1);
          const m = { TITLE: 'title', ARTIST: 'artist', ALBUMARTIST: 'albumArtist', ALBUM: 'album', TRACKNUMBER: 'track', DATE: 'year', GENRE: 'genre' }[k];
          if (m && !out[m]) out[m] = v;
        }
      } else if (type === 6 && !out.pic) {
        const be = (o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
        let q = d + 4; const ml = be(q); const mime = td('latin1').decode(b.subarray(q + 4, q + 4 + ml)); q += 4 + ml;
        const dl = be(q); q += 4 + dl + 16; const pl = be(q); q += 4;
        out.pic = new Blob([b.subarray(q, q + pl)], { type: mime || 'image/jpeg' });
      }
      if (last) break;
      p = d + len;
    }
    if (out.track) out.track = parseInt(out.track) || null;
    if (out.year) out.year = parseInt(String(out.year).slice(0, 4)) || null;
    return out;
  }

  // b: Uint8Array of the start of the file. Returns {title, artist, album, ..., pic: Blob, duration, needBytes}
  window.readTags = function (b, fileSize) {
    const t = id3(b);
    if (t) {
      if (t.tagSize > b.length) return { needBytes: t.tagSize + 16 * 1024 };
      if (!t.duration) t.duration = mp3Duration(b, t.tagSize, fileSize);
      return t;
    }
    const f = flac(b);
    if (f) return f;
    const m = mp4(b);
    if (m) return m;
    return { duration: mp3Duration(b, 0, fileSize) };
  };
})();
