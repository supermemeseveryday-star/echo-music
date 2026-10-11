// Echo data layer. Runs in the browser:
// - music: audio files in a Cloudflare R2 bucket (under music/), plus Internet Archive
// - state: playlists, likes, history, track index -> localStorage, synced to echo/data.json in the same bucket
// The browser never holds R2 keys: /api/sign hands out short-lived signed links for single objects.
(function () {
  const LS_KEY = 'echo.r2.v1';
  const STATE_KEY = 'echo/data.json';
  // data from the Google Drive / Blob versions is not carried over: start clean
  try { localStorage.removeItem('echo.state.v2'); } catch {}
  const MUSIC = 'music/';
  const empty = () => ({ tracks: {}, likes: [], playlists: [], history: [], covers: {}, updatedAt: 0, at: {} });
  // Each part of the state syncs on its own clock, so a change on one device (say, a new playlist on the phone)
  // isn't overwritten by an unrelated change on another (say, the computer playing a song).
  const SECTIONS = { playlists: ['playlists'], likes: ['likes'], history: ['history'], library: ['tracks', 'covers'] };

  let S = empty();
  let signedIn = false;
  let me = null;
  let pushTimer = null;
  const listeners = new Set();

  // ---------- auth + signed links ----------
  async function apiFetch(url, opts = {}) {
    const r = await fetch(url, { credentials: 'same-origin', ...opts });
    if (r.status === 401) { signedIn = false; throw new Error('signed_out'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `http_${r.status}`);
    return j;
  }
  const postJson = (url, body) => apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const urlCache = new Map(); // key -> { url, exp }
  // fresh-enough GET links for many keys at once
  async function signGet(keys, force = false) {
    const now = Date.now();
    const need = [...new Set(keys)].filter((k) => force || !(urlCache.get(k)?.exp > now + 60 * 60e3));
    for (let i = 0; i < need.length; i += 500) {
      const j = await postJson('/api/sign', { get: need.slice(i, i + 500) });
      for (const [k, url] of Object.entries(j.urls)) urlCache.set(k, { url, exp: now + (j.ttl - 300) * 1000 });
    }
    return Object.fromEntries(keys.map((k) => [k, urlCache.get(k).url]));
  }
  const signOne = async (key, force) => (await signGet([key], force))[key];
  const signPut = async (key) => (await postJson('/api/sign', { put: key })).url;

  // ---------- state persistence ----------
  function serialize() {
    const tracks = {};
    for (const [id, t] of Object.entries(S.tracks)) tracks[id] = t.coverKey ? { ...t, cover: undefined } : t;
    return JSON.stringify({ ...S, tracks });
  }
  function hydrate(raw) {
    const s = { ...empty(), ...raw };
    s.at = { ...s.at };
    for (const sec of Object.keys(SECTIONS)) s.at[sec] ??= s.updatedAt || 0; // states saved before per-part clocks
    for (const t of Object.values(s.tracks)) if (t.coverKey) t.cover = s.covers[t.coverKey] || null;
    return s;
  }
  function saveLocal() { try { localStorage.setItem(LS_KEY, serialize()); } catch (e) { console.warn('local save failed', e); } }
  function changed(...sections) {
    S.updatedAt = Date.now();
    S.at ||= {};
    for (const sec of sections) S.at[sec] = S.updatedAt;
    saveLocal();
    if (signedIn) { clearTimeout(pushTimer); pushTimer = setTimeout(push, 1500); }
  }
  // take every part the other devices changed more recently; report whether we hold newer parts
  function merge(remote) {
    const r = hydrate(remote);
    const took = [];
    let localNewer = false;
    for (const [sec, keys] of Object.entries(SECTIONS)) {
      const ra = r.at[sec] || 0, la = S.at?.[sec] || 0;
      if (ra > la) { for (const k of keys) S[k] = r[k]; S.at[sec] = ra; took.push(sec); }
      else if (la > ra) localNewer = true;
    }
    if (took.length) { saveLocal(); emit(); }
    return { took, localNewer };
  }
  async function readRemote() {
    const r = await fetch(await signOne(STATE_KEY), { cache: 'no-store' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`R2 ${r.status}`);
    return r.json();
  }
  let pulling = null;
  function pull() {
    return (pulling ||= (async () => {
      try {
        const remote = await readRemote();
        if (!remote) return push();
        if (merge(remote).localNewer) await write();
      } finally { pulling = null; }
    })());
  }
  async function push() {
    if (!signedIn) return;
    try {
      const remote = await readRemote();
      if (remote) merge(remote);
      await write();
    } catch (e) { console.warn('sync failed', e); }
  }
  async function write() {
    const r = await fetch(await signPut(STATE_KEY), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: serialize() });
    if (!r.ok) throw new Error(`R2 save ${r.status}`);
  }
  // pick up changes made on other devices while this one stays open
  const refresh = () => { if (signedIn && document.visibilityState === 'visible') pull().catch(() => {}); };
  document.addEventListener('visibilitychange', refresh);
  setInterval(refresh, 60e3);
  const emit = () => listeners.forEach((f) => f(S));

  // ---------- R2 library scan ----------
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
  const trackId = (key) => 'r_' + encodeURIComponent(key);
  async function readHead(key, size, bytes) {
    const want = Math.max(1, Math.min(bytes, size || bytes));
    const r = await fetch(await signOne(key), { headers: { Range: `bytes=0-${want - 1}` } });
    if (!r.ok) throw new Error(`R2 ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }
  async function indexObject(o, previous) {
    const rel = o.key.slice(MUSIC.length);
    const parts = rel.split('/').filter(Boolean);
    const filename = parts[parts.length - 1] || '未知歌曲';
    const folder = parts.length > 1 ? parts[parts.length - 2] : null;
    const base = filename.replace(/\.[^.]+$/, '') || filename;
    const [fArtist, fTitle] = base.includes(' - ') ? base.split(' - ', 2) : [null, base.replace(/^\d+[\s.\-_]+/, '')];
    let tags = {};
    try {
      let head = await readHead(o.key, o.size, 512 * 1024);
      tags = readTags(head, o.size) || {};
      if (tags.needBytes) {
        tags = tags.needBytes <= 8 * 1024 * 1024 ? readTags(await readHead(o.key, o.size, tags.needBytes), o.size) || {} : {};
        if (tags.needBytes) tags = {};
      }
    } catch (e) { if (e.message === 'signed_out') throw e; console.warn('tag read failed', o.key, e); }
    const artist = tags.artist || tags.albumArtist || fArtist || '未知艺人';
    const album = tags.album || folder || '单曲';
    const albumArtist = tags.albumArtist || null;
    let coverKey = null;
    if (tags.pic) {
      coverKey = 'c' + hash(`${albumArtist || artist}\u0000${album}`);
      if (!S.covers[coverKey]) S.covers[coverKey] = await coverDataUrl(tags.pic);
      if (!S.covers[coverKey]) coverKey = null;
    }
    const id = trackId(o.key);
    return {
      id, source: 'r2', key: o.key, etag: o.etag, size: o.size,
      title: tags.title || fTitle || base, artist, albumArtist, album,
      year: tags.year || null, trackNo: tags.track || null, genre: tags.genre || null,
      duration: tags.duration || previous?.duration || 0,
      coverKey, cover: coverKey ? S.covers[coverKey] : null,
      addedAt: previous?.addedAt || Date.parse(o.lastModified) || Date.now(),
    };
  }
  // each top-level folder under music/ is a playlist that follows the folder.
  // Songs added by hand stay; songs that left the folder drop out.
  function syncFolderPlaylists(byFolder) {
    S.playlists = S.playlists.filter((p) => !String(p.source || '').startsWith('r2:') || byFolder.has(p.source.slice(3)));
    const order = (a, b) => (S.tracks[a].album || '').localeCompare(S.tracks[b].album || '') || (S.tracks[a].trackNo ?? 999) - (S.tracks[b].trackNo ?? 999) || (S.tracks[a].title || '').localeCompare(S.tracks[b].title || '');
    for (const [folder, ids] of byFolder) {
      const source = 'r2:' + folder;
      let p = S.playlists.find((x) => x.source === source);
      if (!p) {
        p = { id: 'f_' + hash(source), name: folder, description: '来自云端文件夹，文件夹里的歌有变动会自动更新', items: [], createdAt: Date.now(), source };
        S.playlists.push(p);
      }
      const wanted = new Set(ids);
      p.items = p.items.filter((i) => !i.auto || wanted.has(i.id));
      const have = new Set(p.items.map((i) => i.id));
      for (const id of ids.sort(order)) if (!have.has(id)) p.items.push({ id, at: Date.now(), auto: true });
    }
  }
  let scanning = null;
  function scan(onProgress = () => {}) {
    if (!signedIn) return Promise.resolve({ total: 0, added: 0, removed: 0 });
    return (scanning ||= (async () => {
      try {
        onProgress({ phase: 'list', found: 0 });
        const { items } = await apiFetch('/api/library');
        onProgress({ phase: 'list', found: items.length });
        const seen = new Set();
        const byFolder = new Map();
        const before = JSON.stringify(S.playlists);
        const todo = [];
        for (const o of items) {
          const id = trackId(o.key);
          seen.add(id);
          if (S.tracks[id]?.etag !== o.etag) todo.push(o);
          const parts = o.key.slice(MUSIC.length).split('/').filter(Boolean);
          if (parts.length > 1) { if (!byFolder.has(parts[0])) byFolder.set(parts[0], []); byFolder.get(parts[0]).push(id); }
        }
        let done = 0;
        await pool(todo, 4, async (o) => {
          const id = trackId(o.key);
          S.tracks[id] = await indexObject(o, S.tracks[id]);
          onProgress({ phase: 'index', done: ++done, total: todo.length });
          if (done % 10 === 0) { changed('library'); emit(); }
        });
        let removed = 0;
        for (const [id, t] of Object.entries(S.tracks)) if (t.source === 'r2' && !seen.has(id)) { delete S.tracks[id]; removed++; }
        syncFolderPlaylists(byFolder);
        const used = new Set(Object.values(S.tracks).map((t) => t.coverKey).filter(Boolean));
        for (const k of Object.keys(S.covers)) if (!used.has(k)) delete S.covers[k];
        const sections = [];
        if (todo.length || removed) sections.push('library');
        if (JSON.stringify(S.playlists) !== before) sections.push('playlists');
        if (sections.length) changed(...sections);
        emit();
        return { total: items.length, added: todo.length, removed };
      } finally { scanning = null; }
    })());
  }

  // ---------- upload ----------
  const cleanName = (s) => String(s).replace(/[\\/\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim().slice(0, 200);
  function uploadOne(file, url, onBytes) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('PUT', url);
      x.setRequestHeader('Content-Type', file.type || 'audio/mpeg');
      x.upload.onprogress = (e) => onBytes(e.loaded);
      x.onload = () => (x.status < 300 ? resolve() : reject(new Error(`upload ${x.status}`)));
      x.onerror = () => reject(new Error('network'));
      x.send(file);
    });
  }
  // folder (optional) becomes music/<folder>/..., which also makes it a playlist
  async function upload(files, onProgress, folder = '') {
    const dir = cleanName(folder);
    const total = files.reduce((a, f) => a + f.size, 0) || 1;
    let base = 0, ok = 0;
    for (const f of files) {
      const key = MUSIC + (dir ? dir + '/' : '') + cleanName(f.name);
      await uploadOne(f, await signPut(key), (b) => onProgress((base + b) / total));
      base += f.size; ok++;
    }
    await scan();
    return { uploaded: ok };
  }
  // copy the songs from the old Vercel Blob store, a batch per call
  async function migrateBlob(onProgress) {
    let copied = 0;
    const failed = new Set();
    for (let round = 0; round < 200; round++) {
      const r = await postJson('/api/migrate', {});
      if (r.noBlob) return { total: 0, copied: 0, failed: [], noBlob: true };
      copied += r.copied;
      (r.failed || []).forEach((f) => failed.add(f));
      onProgress({ copied, total: r.total, remaining: r.remaining });
      if (r.done || (!r.copied && r.remaining === 0) || (!r.copied && r.failed?.length)) {
        await scan();
        return { total: r.total, copied, failed: [...failed] };
      }
    }
    throw new Error('migrate_timeout');
  }

  // ---------- playback source ----------
  // 'stream': a signed link the audio element streams with range requests
  // 'fresh': the same with a newly signed link (after a playback error); 'blob': download the whole file
  async function src(t, mode = 'stream') {
    if (t.source !== 'r2') return t.url;
    if (mode !== 'blob') return signOne(t.key, mode === 'fresh');
    const r = await fetch(await signOne(t.key, true));
    if (!r.ok) throw new Error(`R2 ${r.status}`);
    return URL.createObjectURL(await r.blob());
  }

  // whole file into memory (for buffering the next song); null when too big to be worth it
  const BUFFER_MAX = 80 * 1024 * 1024;
  async function download(t, signal) {
    if (t.source === 'r2' && t.size > BUFFER_MAX) return null;
    const r = await fetch(t.source === 'r2' ? await signOne(t.key) : t.url, { signal });
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
    if (a === 'history') { S.history = [{ id: b, at: Date.now() }, ...S.history.filter((h) => h.id !== b)].slice(0, 50); changed('history'); return { ok: true }; }
    if (a === 'likes') {
      const i = S.likes.findIndex((x) => x.id === b);
      if (i >= 0) S.likes.splice(i, 1); else S.likes.unshift({ id: b, at: Date.now() });
      changed('likes'); return { liked: i < 0 };
    }
    if (a === 'playlists') {
      if (!b && method === 'POST') { const p = { id: newId(), name: body.name || `我的歌单 #${S.playlists.length + 1}`, description: '', items: [], createdAt: Date.now() }; S.playlists.push(p); changed('playlists'); return p; }
      const p = S.playlists.find((x) => x.id === b);
      if (method === 'DELETE') { S.playlists = S.playlists.filter((x) => x.id !== b); changed('playlists'); return { ok: true }; }
      if (!p) throw new Error('not found');
      if (c === 'items') { p.items.push({ id: body.id, at: Date.now() }); changed('playlists'); return p; }
      if (method === 'PATCH') {
        if (typeof body.name === 'string') p.name = body.name.trim() || p.name;
        if (typeof body.description === 'string') p.description = body.description;
        if (Array.isArray(body.items)) p.items = body.items;
        changed('playlists'); return p;
      }
    }
    if (a === 'tracks' && method === 'POST') {
      if (body.source !== 'archive' || !String(body.url).startsWith('https://archive.org/')) throw new Error('bad track');
      const id = 'a_' + hash(body.url);
      S.tracks[id] ||= { id, source: 'archive', url: body.url, title: body.title, artist: body.artist || '未知艺人', albumArtist: body.albumArtist || null, album: body.album || 'Internet Archive', year: body.year || null, duration: body.duration || 0, cover: body.cover || null, license: body.license || null, page: body.page || null, trackNo: body.trackNo || null, addedAt: Date.now() };
      changed('library'); return S.tracks[id];
    }
    if (a === 'rescan') { const r = await scan(); return { count: r.total }; }
    if (a === 'archive' && b === 'search') return iaSearch(u.searchParams.get('q') || '');
    if (a === 'archive' && b === 'item') return iaItem(c);
    throw new Error(`unknown route ${method} ${u.pathname}`);
  }

  // ---------- boot ----------
  async function init() {
    try { const raw = localStorage.getItem(LS_KEY); if (raw) S = hydrate(JSON.parse(raw)); } catch {}
    try { me = await apiFetch('/api/me'); signedIn = true; } catch (e) { return { signedIn: false, error: e.message }; }
    if (!me.r2) return { signedIn: true, error: 'r2_not_configured' };
    return { signedIn: true };
  }
  async function login(password) {
    const r = await fetch('/api/auth/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    if (r.status === 401) throw new Error('wrong_password');
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'login_failed');
    return init();
  }
  async function sync() { if (signedIn) await pull(); }
  async function user() { return me; }
  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    signedIn = false; me = null;
    try { localStorage.removeItem(LS_KEY); } catch {}
    S = empty();
  }
  function setDuration(id, d) { const t = S.tracks[id]; if (t && d && Math.abs((t.duration || 0) - d) > 1) { t.duration = d; changed('library'); } }

  window.Store = {
    init, login, sync, scan, upload, migrateBlob, api, src, user, logout, setDuration, download,
    get state() { return S; },
    get signedIn() { return signedIn; },
    onChange: (f) => listeners.add(f),
  };
})();
