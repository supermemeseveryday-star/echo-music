// Echo data layer. Runs entirely in the browser, no account and no server of our own:
// - local: audio files imported from this device, kept in IndexedDB
// - nas: a Subsonic compatible server (Navidrome, Gonic, Airsonic…) the user points us at
// - archive: free music from Internet Archive
// Playlists, likes, history and the track index live in IndexedDB on this device.
(function () {
  const DB_NAME = 'echo';
  const NAS_KEY = 'echo.nas.v1';
  const empty = () => ({ tracks: {}, likes: [], playlists: [], history: [], covers: {} });

  let S = empty();
  let nas = null; // { url, user, salt, token }
  const listeners = new Set();
  const emit = () => listeners.forEach((f) => f(S));

  // ---------- IndexedDB: 'files' holds imported audio, 'kv' holds the library state ----------
  let dbp = null;
  function db() {
    return (dbp ||= new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('files'); r.result.createObjectStore('kv'); };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
  }
  async function idb(store, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  const idbGet = (store, key) => idb(store, 'readonly', (s) => s.get(key));
  const idbPut = (store, key, val) => idb(store, 'readwrite', (s) => s.put(val, key));
  const idbDel = (store, keys) => idb(store, 'readwrite', (s) => { for (const k of [].concat(keys)) s.delete(k); });

  // ---------- state persistence ----------
  function serialize() {
    const tracks = {};
    // covers are rebuilt on load: data URLs live in S.covers once, NAS cover links carry the login token
    for (const [id, t] of Object.entries(S.tracks)) tracks[id] = t.coverKey || t.coverArt ? { ...t, cover: undefined } : t;
    return { ...S, tracks };
  }
  function hydrate(raw) {
    const s = { ...empty(), ...raw };
    for (const t of Object.values(s.tracks)) {
      if (t.coverKey) t.cover = s.covers[t.coverKey] || null;
      else if (t.coverArt) t.cover = nasCover(t.coverArt);
    }
    return s;
  }
  let saveTimer = null;
  const save = () => idbPut('kv', 'state', serialize()).catch((e) => console.warn('save failed', e));
  function changed() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); }
  addEventListener('pagehide', () => { if (saveTimer) { clearTimeout(saveTimer); save(); } });

  // ---------- helpers ----------
  const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
  async function pool(items, n, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
  }
  async function coverDataUrl(blob) {
    try {
      const bmp = await createImageBitmap(blob);
      const size = 320;
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const s = Math.min(bmp.width, bmp.height);
      c.getContext('2d').drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, size, size);
      return c.toDataURL('image/jpeg', 0.82);
    } catch { return null; }
  }
  const AUDIO = /\.(mp3|m4a|aac|flac|wav|ogg|opus)$/i;
  const isAudio = (f) => /^audio\//.test(f.type) || AUDIO.test(f.name);
  // a folder becomes a playlist; songs already in it stay where the user put them
  function folderPlaylist(source, name, ids, description) {
    let p = S.playlists.find((x) => x.source === source);
    if (!p) { p = { id: 'f_' + hash(source), name, description, items: [], createdAt: Date.now(), source }; S.playlists.push(p); }
    const have = new Set(p.items.map((i) => i.id));
    for (const id of ids) if (!have.has(id)) { p.items.push({ id, at: Date.now(), auto: true }); have.add(id); }
    return p;
  }

  // ---------- local files ----------
  async function readFileTags(file) {
    try {
      let tags = readTags(new Uint8Array(await file.slice(0, 512 * 1024).arrayBuffer()), file.size) || {};
      if (tags.needBytes) tags = tags.needBytes <= 8 * 1024 * 1024 ? readTags(new Uint8Array(await file.slice(0, tags.needBytes).arrayBuffer()), file.size) || {} : {};
      return tags.needBytes ? {} : tags;
    } catch (e) { console.warn('tag read failed', file.name, e); return {}; }
  }
  // files: File[]; folder: playlist name for all of them, otherwise each file's own folder (folder picker) is used
  async function importFiles(files, { folder = '', onProgress = () => {} } = {}) {
    files = files.filter(isAudio);
    if (!files.length) return { added: 0, skipped: 0 };
    navigator.storage?.persist?.().catch(() => {}); // ask the browser not to clear our storage when space runs low
    let added = 0, skipped = 0, done = 0;
    const byFolder = new Map();
    await pool(files, 2, async (file) => {
      const id = 'l_' + hash(file.name) + hash(`${file.size}:${file.lastModified}`);
      const parts = (file.webkitRelativePath || '').split('/').filter(Boolean);
      const dir = folder.trim() || (parts.length > 1 ? parts[parts.length - 2] : '');
      if (dir) { if (!byFolder.has(dir)) byFolder.set(dir, []); byFolder.get(dir).push(id); }
      if (S.tracks[id]) { skipped++; onProgress(++done, files.length); return; }
      await idbPut('files', id, file);
      const tags = await readFileTags(file);
      const base = file.name.replace(/\.[^.]+$/, '') || file.name;
      const [fArtist, fTitle] = base.includes(' - ') ? base.split(' - ', 2) : [null, base.replace(/^\d+[\s.\-_]+/, '')];
      const artist = tags.artist || tags.albumArtist || fArtist || '未知艺人';
      const album = tags.album || dir || '单曲';
      let coverKey = null;
      if (tags.pic) {
        coverKey = 'c' + hash(`${tags.albumArtist || artist}\u0000${album}`);
        if (!S.covers[coverKey]) S.covers[coverKey] = await coverDataUrl(tags.pic);
        if (!S.covers[coverKey]) coverKey = null;
      }
      S.tracks[id] = {
        id, source: 'local', fileName: file.name, size: file.size, type: file.type || 'audio/mpeg',
        title: tags.title || fTitle || base, artist, albumArtist: tags.albumArtist || null, album,
        year: tags.year || null, trackNo: tags.track || null, genre: tags.genre || null, duration: tags.duration || 0,
        coverKey, cover: coverKey ? S.covers[coverKey] : null, addedAt: Date.now(),
      };
      added++;
      onProgress(++done, files.length);
      if (added % 10 === 0) { changed(); emit(); }
    });
    for (const [dir, ids] of byFolder) folderPlaylist('local:' + dir, dir, ids, '从本机文件夹导入');
    changed(); emit();
    return { added, skipped };
  }
  // forget songs everywhere: library, playlists, likes, history (and the stored file for local ones)
  function dropTracks(ids) {
    const gone = new Set(ids);
    for (const id of gone) delete S.tracks[id];
    S.likes = S.likes.filter((l) => !gone.has(l.id));
    S.history = S.history.filter((h) => !gone.has(h.id));
    for (const p of S.playlists) p.items = p.items.filter((i) => !gone.has(i.id));
    const used = new Set(Object.values(S.tracks).map((t) => t.coverKey).filter(Boolean));
    for (const k of Object.keys(S.covers)) if (!used.has(k)) delete S.covers[k];
  }
  async function deleteLocal(ids) {
    ids = ids.filter((id) => S.tracks[id]?.source === 'local');
    await idbDel('files', ids);
    dropTracks(ids);
    S.playlists = S.playlists.filter((p) => !String(p.source || '').startsWith('local:') || p.items.length);
    changed(); emit();
    return ids.length;
  }
  async function localFile(id) {
    const f = await idbGet('files', id);
    if (!f) throw new Error('local_missing');
    return f;
  }
  async function storageInfo() {
    const est = await navigator.storage?.estimate?.().catch(() => null);
    const persisted = await navigator.storage?.persisted?.().catch(() => false);
    const local = Object.values(S.tracks).filter((t) => t.source === 'local');
    return { used: est?.usage || local.reduce((a, t) => a + (t.size || 0), 0), quota: est?.quota || 0, persisted: !!persisted, count: local.length };
  }

  // ---------- NAS (Subsonic API) ----------
  // token auth: we keep md5(password + salt) and the salt, never the password itself
  function md5(str) {
    const bytes = new TextEncoder().encode(str), n = bytes.length;
    const words = new Uint32Array((((n + 8) >> 6) + 1) * 16);
    for (let i = 0; i < n; i++) words[i >> 2] |= bytes[i] << ((i % 4) * 8);
    words[n >> 2] |= 0x80 << ((n % 4) * 8);
    words[words.length - 2] = n * 8;
    const R = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let o = 0; o < words.length; o += 16) {
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        const r = i >> 4;
        const F = r === 0 ? (B & C) | (~B & D) : r === 1 ? (D & B) | (~D & C) : r === 2 ? B ^ C ^ D : C ^ (B | ~D);
        const g = r === 0 ? i : r === 1 ? (5 * i + 1) % 16 : r === 2 ? (3 * i + 5) % 16 : (7 * i) % 16;
        const s = R[r * 4 + (i % 4)];
        const f = (F + A + K[i] + words[o + g]) >>> 0;
        A = D; D = C; C = B;
        B = (B + ((f << s) | (f >>> (32 - s)))) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    return [a0, b0, c0, d0].map((x) => [0, 8, 16, 24].map((b) => ((x >>> b) & 255).toString(16).padStart(2, '0')).join('')).join('');
  }
  const nasParams = (c = nas, extra = {}) => new URLSearchParams({ u: c.user, t: c.token, s: c.salt, v: '1.16.1', c: 'echo', f: 'json', ...extra });
  const nasUrl = (method, extra, c = nas) => `${c.url}/rest/${method}.view?${nasParams(c, extra)}`;
  function nasCover(coverArt) { return nas && coverArt ? nasUrl('getCoverArt', { id: coverArt, size: 300 }) : null; }
  async function nasCall(method, extra = {}, c = nas) {
    let r;
    try { r = await fetch(nasUrl(method, extra, c)); } catch { throw new Error('nas_unreachable'); }
    const j = await r.json().catch(() => null);
    const res = j?.['subsonic-response'];
    if (!res) throw new Error(r.ok ? 'nas_not_subsonic' : `nas_http_${r.status}`);
    if (res.status !== 'ok') throw new Error(res.error?.code === 40 ? 'nas_wrong_login' : res.error?.code === 41 ? 'nas_token_unsupported' : `nas_error: ${res.error?.message || res.error?.code}`);
    return res;
  }
  function normalizeUrl(u) {
    u = String(u || '').trim().replace(/\/+$/, '').replace(/\/rest$/, '');
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    const url = new URL(u);
    // an https page can't load http addresses (browsers block it); localhost is the one exception
    if (location.protocol === 'https:' && url.protocol === 'http:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)) throw new Error('nas_needs_https');
    return u;
  }
  async function nasConnect({ url, user, password }) {
    const salt = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
    const c = { url: normalizeUrl(url), user: String(user).trim(), salt, token: md5(String(password) + salt) };
    await nasCall('ping', {}, c);
    nas = c;
    try { localStorage.setItem(NAS_KEY, JSON.stringify(nas)); } catch {}
    return nasSync();
  }
  function nasDisconnect() {
    nas = null;
    try { localStorage.removeItem(NAS_KEY); } catch {}
    dropTracks(Object.keys(S.tracks).filter((id) => S.tracks[id].source === 'nas'));
    S.playlists = S.playlists.filter((p) => !String(p.source || '').startsWith('nas:'));
    changed(); emit();
  }
  const nasTrackId = (songId) => 'n_' + encodeURIComponent(songId);
  function nasTrack(s, previous) {
    const id = nasTrackId(s.id);
    return {
      id, source: 'nas', nasId: s.id, title: s.title || '未知歌曲', artist: s.artist || '未知艺人',
      albumArtist: s.displayAlbumArtist || s.albumArtists?.[0]?.name || null, album: s.album || '单曲',
      year: s.year || null, trackNo: s.track || null, genre: s.genre || null, duration: s.duration || 0, size: s.size || 0,
      coverArt: s.coverArt || null, cover: nasCover(s.coverArt), addedAt: previous?.addedAt || Date.parse(s.created) || Date.now(),
    };
  }
  const NAS_MAX = 30000;
  let syncing = null;
  function nasSync(onProgress = () => {}) {
    if (!nas) return Promise.resolve(null);
    return (syncing ||= (async () => {
      try {
        const seen = new Set();
        const keep = (s) => { const id = nasTrackId(s.id); seen.add(id); S.tracks[id] = nasTrack(s, S.tracks[id]); return id; };
        // every song (an empty search lists the whole library on Navidrome and most other servers)
        for (let offset = 0; offset < NAS_MAX; offset += 500) {
          const res = await nasCall('search3', { query: '', songCount: 500, songOffset: offset, artistCount: 0, albumCount: 0 });
          const songs = res.searchResult3?.song || [];
          songs.forEach(keep);
          onProgress({ phase: 'songs', count: seen.size });
          if (songs.length < 500) break;
        }
        // the server's playlists, mirrored; songs added here by hand stay
        const { playlists } = await nasCall('getPlaylists');
        const lists = playlists?.playlist || [];
        const wanted = new Set();
        let i = 0;
        for (const pl of lists) {
          const { playlist } = await nasCall('getPlaylist', { id: pl.id });
          const ids = (playlist.entry || []).map(keep);
          const source = 'nas:' + pl.id;
          wanted.add(source);
          const p = folderPlaylist(source, pl.name, [], 'NAS 上的歌单，每次同步会自动更新');
          p.name = pl.name;
          if (pl.comment) p.description = pl.comment;
          const set = new Set(ids);
          p.items = [...ids.map((id) => p.items.find((x) => x.id === id && x.auto) || { id, at: Date.now(), auto: true }), ...p.items.filter((x) => !x.auto && !set.has(x.id))];
          onProgress({ phase: 'playlists', done: ++i, total: lists.length });
        }
        S.playlists = S.playlists.filter((p) => !String(p.source || '').startsWith('nas:') || wanted.has(p.source));
        const removed = Object.keys(S.tracks).filter((id) => S.tracks[id].source === 'nas' && !seen.has(id));
        dropTracks(removed);
        changed(); emit();
        return { songs: seen.size, playlists: lists.length, removed: removed.length };
      } finally { syncing = null; }
    })());
  }

  // ---------- playback source ----------
  const objectUrls = new Map(); // local track id -> blob: URL (kept while the page lives)
  async function src(t) {
    if (t.source === 'local') {
      if (!objectUrls.has(t.id)) objectUrls.set(t.id, URL.createObjectURL(await localFile(t.id)));
      return objectUrls.get(t.id);
    }
    if (t.source === 'nas') {
      if (!nas) throw new Error('nas_disconnected');
      return nasUrl('stream', { id: t.nasId });
    }
    return t.url;
  }
  // whole file into memory (for buffering the next song); null when there is nothing to gain
  const BUFFER_MAX = 80 * 1024 * 1024;
  async function download(t, signal) {
    if (t.source === 'local') return null; // already on the device
    if (t.size > BUFFER_MAX) return null;
    const r = await fetch(await src(t), { signal });
    if (!r.ok) throw new Error(`download ${r.status}`);
    return URL.createObjectURL(await r.blob());
  }

  // ---------- Internet Archive (CORS enabled, called directly) ----------
  const iaLen = (l) => (!l ? 0 : String(l).includes(':') ? String(l).split(':').reduce((a, b) => a * 60 + Number(b), 0) : Number(l) || 0);
  async function iaSearch(q) {
    const query = `(${q}) AND mediatype:audio AND (collection:netlabels OR collection:audio_music OR collection:78rpm OR collection:georgeblood OR collection:etree OR (collection:opensource_audio AND subject:music)) AND -collection:librivoxaudio AND -collection:podcasts AND -collection:oldtimeradio`;
    const j = await (await fetch('https://archive.org/advancedsearch.php?' + new URLSearchParams({ q: query, 'fl[]': 'identifier,title,creator,year,licenseurl', rows: '24', output: 'json', sort: 'downloads desc' }))).json();
    return j.response.docs.map((d) => ({ id: d.identifier, title: d.title, creator: [].concat(d.creator || '未知')[0], year: d.year, license: d.licenseurl || null, cover: `https://archive.org/services/img/${d.identifier}` }));
  }
  async function iaItem(id) {
    const j = await (await fetch(`https://archive.org/metadata/${encodeURIComponent(id)}`)).json();
    const m = j.metadata || {};
    const all = j.files || [];
    const originals = all.filter((f) => f.source === 'original' && /\.mp3$/i.test(f.name));
    const files = originals.length ? originals : all.filter((f) => f.format === 'VBR MP3');
    const seen = new Set();
    const tracks = [];
    for (const f of files) {
      const key = f.title || f.name.replace(/\.[^.]+$/, '');
      if (seen.has(key)) continue;
      seen.add(key);
      tracks.push({ source: 'archive', url: `https://archive.org/download/${m.identifier}/${encodeURIComponent(f.name)}`, title: f.title || key, artist: f.creator || f.artist || [].concat(m.creator || '未知艺人')[0], album: f.album || m.title, duration: iaLen(f.length), trackNo: parseInt(f.track) || null });
    }
    tracks.sort((a, b) => (a.trackNo ?? 1e9) - (b.trackNo ?? 1e9));
    return { id: m.identifier, title: m.title, creator: [].concat(m.creator || '未知')[0], year: m.year || m.date, license: m.licenseurl || null, description: String(m.description || '').replace(/<[^>]+>/g, ' ').slice(0, 600), cover: `https://archive.org/services/img/${m.identifier}`, page: `https://archive.org/details/${m.identifier}`, tracks: tracks.slice(0, 100) };
  }

  // ---------- API-shaped router used by app.js ----------
  const newId = () => Math.random().toString(36).slice(2, 10);
  async function api(url, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body || {};
    const u = new URL(url, location.origin);
    const parts = u.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent); // drop "api"
    const [a, b, c] = parts;
    if (a === 'state') return S;
    if (a === 'history') { S.history = [{ id: b, at: Date.now() }, ...S.history.filter((h) => h.id !== b)].slice(0, 50); changed(); return { ok: true }; }
    if (a === 'likes') {
      const i = S.likes.findIndex((x) => x.id === b);
      if (i >= 0) S.likes.splice(i, 1); else S.likes.unshift({ id: b, at: Date.now() });
      changed(); return { liked: i < 0 };
    }
    if (a === 'playlists') {
      if (!b && method === 'POST') { const p = { id: newId(), name: body.name || `我的歌单 #${S.playlists.length + 1}`, description: '', items: [], createdAt: Date.now() }; S.playlists.push(p); changed(); return p; }
      const p = S.playlists.find((x) => x.id === b);
      if (method === 'DELETE') { S.playlists = S.playlists.filter((x) => x.id !== b); changed(); return { ok: true }; }
      if (!p) throw new Error('not found');
      if (c === 'items') { p.items.push({ id: body.id, at: Date.now() }); changed(); return p; }
      if (method === 'PATCH') {
        if (typeof body.name === 'string') p.name = body.name.trim() || p.name;
        if (typeof body.description === 'string') p.description = body.description;
        if (Array.isArray(body.items)) p.items = body.items;
        changed(); return p;
      }
    }
    if (a === 'tracks' && method === 'POST') {
      if (body.source !== 'archive' || !String(body.url).startsWith('https://archive.org/')) throw new Error('bad track');
      const id = 'a_' + hash(body.url);
      S.tracks[id] ||= { id, source: 'archive', url: body.url, title: body.title, artist: body.artist || '未知艺人', albumArtist: body.albumArtist || null, album: body.album || 'Internet Archive', year: body.year || null, duration: body.duration || 0, cover: body.cover || null, license: body.license || null, page: body.page || null, trackNo: body.trackNo || null, addedAt: Date.now() };
      changed(); return S.tracks[id];
    }
    if (a === 'archive' && b === 'search') return iaSearch(u.searchParams.get('q') || '');
    if (a === 'archive' && b === 'item') return iaItem(c);
    throw new Error(`unknown route ${method} ${u.pathname}`);
  }

  // ---------- boot ----------
  async function init() {
    try { nas = JSON.parse(localStorage.getItem(NAS_KEY) || 'null'); } catch {}
    try {
      const raw = await idbGet('kv', 'state');
      if (raw) S = hydrate(raw);
      else {
        // the old cloud version kept its state in localStorage: keep the free-library songs, likes and playlists
        const old = JSON.parse(localStorage.getItem('echo.r2.v1') || 'null');
        if (old) {
          S = hydrate(old);
          dropTracks(Object.keys(S.tracks).filter((id) => S.tracks[id].source !== 'archive'));
          S.playlists = S.playlists.filter((p) => !String(p.source || '').startsWith('r2:'));
          delete S.at; delete S.updatedAt;
          await save();
        }
      }
      localStorage.removeItem('echo.r2.v1');
    } catch (e) { console.warn('load failed', e); }
  }
  function setDuration(id, d) { const t = S.tracks[id]; if (t && d && Math.abs((t.duration || 0) - d) > 1) { t.duration = d; changed(); } }

  window.Store = {
    init, api, src, download, setDuration,
    importFiles, deleteLocal, storageInfo,
    nasConnect, nasDisconnect, nasSync,
    get nas() { return nas && { url: nas.url, user: nas.user }; },
    get state() { return S; },
    onChange: (f) => listeners.add(f),
    _md5: md5,
  };
})();
