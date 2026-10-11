// Echo front end: hash-routed single page app, no build step.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;
const fmt = (s) => { s = Math.floor(s || 0); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fmtLong = (s) => { const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分钟` : `${m} 分钟`; };
const api = (url, opts) => Store.api(url, opts);

let S = { tracks: {}, likes: [], playlists: [], history: [] };
const audio = $('#audio');

// ---------- derived catalog ----------
function catalog() {
  // free-library tracks only count as "yours" once liked or put in a playlist
  const kept = new Set([...S.likes.map((l) => l.id), ...S.playlists.flatMap((p) => p.items.map((i) => i.id))]);
  const tracks = Object.values(S.tracks).filter((t) => t.source !== 'archive' || kept.has(t.id));
  const albums = {}, artists = {};
  for (const t of tracks) {
    const aa = t.albumArtist || t.artist;
    const ak = `${aa}\u0000${t.album}`;
    (albums[ak] ||= { key: ak, title: t.album, artist: aa, year: t.year, cover: null, tracks: [] }).tracks.push(t);
    if (!albums[ak].cover && t.cover) albums[ak].cover = t.cover;
    (artists[t.artist] ||= { name: t.artist, cover: null, tracks: [] }).tracks.push(t);
    if (!artists[t.artist].cover && t.cover) artists[t.artist].cover = t.cover;
  }
  for (const a of Object.values(albums)) a.tracks.sort((x, y) => (x.trackNo ?? 999) - (y.trackNo ?? 999) || x.title.localeCompare(y.title));
  return { tracks, albums: Object.values(albums), artists: Object.values(artists) };
}
const isLiked = (id) => S.likes.some((l) => l.id === id);
const likedTracks = () => S.likes.map((l) => S.tracks[l.id]).filter(Boolean);
const plTracks = (p) => p.items.map((i) => S.tracks[i.id]).filter(Boolean);
const srcOf = (t, mode) => Store.src(t, mode);

// generated placeholder colours, stable per string
function hue(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function art(cover, seed, cls = 'art', icon = 'ic-note') {
  if (cover) return `<img class="${cls}" src="${esc(cover)}" alt="" loading="lazy" onerror="this.outerHTML=window.ph('${esc(String(seed).replace(/'/g, ''))}','${cls}','${icon}')">`;
  return ph(seed, cls, icon);
}
function ph(seed, cls, icon = 'ic-note') {
  const h = hue(seed);
  return `<div class="${cls}" style="background:linear-gradient(135deg,hsl(${h} 45% 38%),hsl(${(h + 40) % 360} 40% 18%))"><i class="ic ${icon}" style="color:hsl(${h} 30% 75%)"></i></div>`;
}
window.ph = ph;
function plCover(p) {
  const covers = [...new Set(plTracks(p).map((t) => t.cover).filter(Boolean))];
  if (covers.length >= 4) return `<div class="art" style="display:grid;grid-template-columns:1fr 1fr">${covers.slice(0, 4).map((c) => `<img src="${esc(c)}" style="width:100%;height:100%;object-fit:cover">`).join('')}</div>`;
  return art(covers[0], p.name, 'art', 'ic-note');
}

// ---------- player ----------
const P = {
  queue: [], // track ids (context order)
  order: [], // indexes into queue in play order
  pos: -1,
  upNext: [], // manually queued ids, play before context
  context: null, // {label, href}
  shuffle: false,
  repeat: 'off', // off | all | one
  current: null,
};

function playList(ids, startIdx = 0, context = null) {
  if (!ids.length) return;
  P.queue = ids.slice();
  P.context = context;
  buildOrder(startIdx);
  P.pos = 0;
  loadTrack(P.queue[P.order[0]], true);
}
function buildOrder(first) {
  const idx = P.queue.map((_, i) => i);
  if (P.shuffle) {
    const rest = idx.filter((i) => i !== first);
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
    P.order = [first, ...rest];
  } else {
    P.order = idx.slice(first); // repeat-all wraps around in next()
  }
}
const touchUI = matchMedia('(pointer: coarse)');
let loadSeq = 0, srcRetry = 0;
// Buffer the next song while the current one plays, so the switch needs no network at all:
// the whole file is downloaded into memory and played from there (big files: just a fresh address).
// This also matters on a locked iPhone, which only lets the next song start if it starts right away.
let nextBuf = null; // { id, at, stream, blob, ctrl }
function upcomingId() {
  if (P.repeat === 'one') return P.current;
  if (P.upNext.length) return P.upNext[0];
  if (P.pos + 1 < P.order.length) return P.queue[P.order[P.pos + 1]];
  if (P.repeat === 'all' && !P.shuffle && P.queue.length) return P.queue[0];
  return null;
}
function dropBuf() {
  if (!nextBuf) return;
  nextBuf.ctrl.abort();
  if (nextBuf.blob) URL.revokeObjectURL(nextBuf.blob);
  nextBuf = null;
}
function prefetchNext() {
  const id = upcomingId(), t = S.tracks[id];
  if (nextBuf?.id === id && (nextBuf.blob || Date.now() - nextBuf.at < 30 * 60e3)) return;
  dropBuf();
  if (!t || id === P.current) return;
  const buf = nextBuf = { id, at: Date.now(), stream: null, blob: null, ctrl: new AbortController() };
  srcOf(t).then((url) => { buf.stream = url; }).catch(() => {});
  Store.download(t, buf.ctrl.signal)
    .then((url) => { if (nextBuf === buf && url) buf.blob = url; else if (url) URL.revokeObjectURL(url); })
    .catch(() => {});
}
// start once the current song has really started (not skipped right away), or near its end
audio.addEventListener('timeupdate', () => { if (P.current && (audio.currentTime > 10 || audio.duration - audio.currentTime < 60)) prefetchNext(); });
async function loadTrack(id, autoplay, startAt = 0) {
  const t = S.tracks[id];
  if (!t) return;
  P.current = id;
  const seq = ++loadSeq;
  srcRetry = 0;
  let url = null;
  if (nextBuf?.id === id) {
    url = nextBuf.blob || (Date.now() - nextBuf.at < 50 * 60e3 ? nextBuf.stream : null);
    if (nextBuf.blob) nextBuf.blob = null; // now owned by the player, freed when the song changes
  }
  dropBuf();
  if (!url) {
    renderNowPlaying();
    try { url = await srcOf(t); } catch (e) { return playError(e); }
    if (seq !== loadSeq) return;
  }
  setAudioSrc(url, startAt);
  if (autoplay) audio.play().catch(() => {});
  api(`/api/history/${id}`, { method: 'POST' });
  savePlayer();
  renderNowPlaying();
  markPlaying();
  mediaSession(t);
}
let stallTimer;
function setAudioSrc(url, startAt = 0) {
  if (audio.src.startsWith('blob:')) URL.revokeObjectURL(audio.src);
  audio.src = url;
  clearTimeout(stallTimer);
  // a request that never answers fires no error event, so watch for it
  if (!url.startsWith('blob:')) {
    const seq = loadSeq;
    stallTimer = setTimeout(() => { if (seq === loadSeq && audio.readyState < 1 && !audio.paused) recoverPlayback(); }, 10000);
  }
  if (startAt) audio.addEventListener('loadedmetadata', () => { audio.currentTime = startAt; }, { once: true });
}
// a NAS stream can drop (phone switched network, server restarted): retry once, then download the whole song
async function recoverPlayback() {
  const t = S.tracks[P.current];
  if (!t) return;
  const at = audio.currentTime;
  const seq = loadSeq;
  srcRetry++;
  try {
    if (t.source !== 'nas' || srcRetry > 2) throw new Error('give up');
    if (srcRetry === 2) toast('正在下载这首歌…');
    const url = srcRetry === 1 ? await srcOf(t) : await Store.download(t);
    if (seq !== loadSeq || !url) return;
    setAudioSrc(url, at);
    audio.play().catch(() => {});
  } catch {
    toast('这首歌无法播放，跳到下一首');
    setTimeout(() => next(true), 800);
  }
}
function playError(e) {
  toast({ local_missing: '这首歌的文件不在这台设备上了', nas_disconnected: '还没连接 NAS，去设置里连接' }[e?.message] || '这首歌无法播放');
}
function next(auto = false) {
  if (P.repeat === 'one' && auto) { audio.currentTime = 0; audio.play(); return; }
  if (P.upNext.length) { loadTrack(P.upNext.shift(), true); return; }
  if (P.pos + 1 < P.order.length) { P.pos++; loadTrack(P.queue[P.order[P.pos]], true); return; }
  if (P.repeat === 'all' && P.queue.length) { buildOrder(P.shuffle ? Math.floor(Math.random() * P.queue.length) : 0); P.pos = 0; loadTrack(P.queue[P.order[0]], true); return; }
  if (!auto) return;
  audio.pause(); audio.currentTime = 0; renderControls();
}
function prev() {
  if (audio.currentTime > 3 || P.pos <= 0) { audio.currentTime = 0; return; }
  P.pos--; loadTrack(P.queue[P.order[P.pos]], true);
}
function togglePlay() {
  if (!P.current) { const ids = (likedTracks().length ? likedTracks() : catalog().tracks).map((t) => t.id); return playList(ids, 0); }
  if (!audio.src) return loadTrack(P.current, true);
  audio.paused ? audio.play() : audio.pause();
}
function upcoming() {
  return { manual: P.upNext.map((id) => S.tracks[id]).filter(Boolean), ctx: P.order.slice(P.pos + 1).map((i) => S.tracks[P.queue[i]]).filter(Boolean) };
}
function addToQueue(id) { P.upNext.push(id); toast('已加入播放队列'); savePlayer(); if (panelMode === 'queue') renderPanel(); }
function isCtxPlaying(href) { return P.context?.href === href && !audio.paused; }
function playCtx(ids, href, label, start = 0) {
  if (P.context?.href === href && P.current && start === 0 && ids.includes(P.current)) return togglePlay();
  playList(ids, start, { href, label });
}

function savePlayer() {
  try { localStorage.setItem('echo.player', JSON.stringify({ ...P, time: audio.currentTime, volume: audio.volume, muted: audio.muted })); } catch {}
}
function restorePlayer() {
  try {
    const s = JSON.parse(localStorage.getItem('echo.player') || 'null');
    if (!s) return;
    Object.assign(P, { queue: s.queue || [], order: s.order || [], pos: s.pos ?? -1, upNext: s.upNext || [], context: s.context, shuffle: !!s.shuffle, repeat: s.repeat || 'off' });
    audio.volume = s.volume ?? 0.8; audio.muted = !!s.muted;
    if (s.current && S.tracks[s.current]) {
      P.current = s.current;
      mediaSession(S.tracks[s.current]);
      srcOf(S.tracks[s.current]).then((url) => { audio.preload = 'metadata'; setAudioSrc(url, s.time || 0); }).catch(() => {});
    }
  } catch {}
}
function mediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album, artwork: t.cover ? [{ src: t.cover, sizes: '512x512' }] : [] });
  navigator.mediaSession.setActionHandler('play', () => audio.play());
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('previoustrack', prev);
  navigator.mediaSession.setActionHandler('nexttrack', () => next());
  navigator.mediaSession.setActionHandler('seekto', (d) => { audio.currentTime = d.seekTime; });
}

// player bar
const seek = $('#seek'), vol = $('#volume');
let seeking = false;
const tCur = $('#tCur'), miniProg = $('#miniProg');
let lastSaved = 0;
audio.addEventListener('timeupdate', () => {
  if (!seeking && audio.duration) { seek.value = (audio.currentTime / audio.duration) * 1000; paintSlider(seek); }
  const cur = fmt(audio.currentTime);
  if (tCur.textContent !== cur) tCur.textContent = cur;
  // transform instead of width: moves on the GPU, no layout work every tick
  if (audio.duration) miniProg.style.transform = `scaleX(${audio.currentTime / audio.duration})`;
  if (Date.now() - lastSaved > 5000) { lastSaved = Date.now(); savePlayer(); }
});
audio.addEventListener('loadedmetadata', () => { $('#tDur').textContent = fmt(audio.duration); if (isFinite(audio.duration)) Store.setDuration(P.current, audio.duration); });
audio.addEventListener('play', () => { renderControls(); markPlaying(); });
audio.addEventListener('pause', () => { renderControls(); markPlaying(); savePlayer(); });
audio.addEventListener('ended', () => next(true));
audio.addEventListener('error', () => { if (P.current && audio.src) recoverPlayback(); });
seek.addEventListener('input', () => { seeking = true; paintSlider(seek); $('#tCur').textContent = fmt((seek.value / 1000) * (audio.duration || 0)); });
seek.addEventListener('change', () => { if (audio.duration) audio.currentTime = (seek.value / 1000) * audio.duration; seeking = false; });
vol.addEventListener('input', () => { audio.volume = vol.value / 100; audio.muted = false; renderControls(); savePlayer(); });
$('#playBtn').onclick = togglePlay;
$('#nextBtn').onclick = () => next();
$('#prevBtn').onclick = prev;
$('#muteBtn').onclick = () => { audio.muted = !audio.muted; renderControls(); savePlayer(); };
$('#shuffleBtn').onclick = () => {
  P.shuffle = !P.shuffle;
  if (P.current && P.queue.length) { const cur = P.queue.indexOf(P.current); buildOrder(Math.max(cur, 0)); P.pos = 0; }
  renderControls(); savePlayer(); if (panelMode === 'queue') renderPanel();
};
$('#repeatBtn').onclick = () => {
  P.repeat = { off: 'all', all: 'one', one: 'off' }[P.repeat];
  if (P.current && !P.shuffle) { const cur = P.queue.indexOf(P.current); buildOrder(Math.max(cur, 0)); P.pos = 0; }
  renderControls(); savePlayer();
};
$('#queueBtn').onclick = () => setPanel(panelMode === 'queue' ? 'np' : 'queue');

function paintSlider(el) { el.style.setProperty('--p', `${(el.value / el.max) * 100}%`); }
// swap an icon in place instead of rebuilding the button, so a press animation isn't cut off
function setIcon(btn, name) {
  const i = btn.querySelector('.ic');
  if (!i) { btn.innerHTML = `<i class="ic ${name}"></i>`; return; }
  if (!i.classList.contains(name)) i.className = `ic ${name}`;
}
function renderControls() {
  setIcon($('#playBtn'), audio.paused ? 'ic-play' : 'ic-pause');
  $('#playBtn').title = audio.paused ? '播放' : '暂停';
  $('#shuffleBtn').classList.toggle('on', P.shuffle);
  $('#repeatBtn').classList.toggle('on', P.repeat !== 'off');
  $('#repeatBtn').classList.toggle('one', P.repeat === 'one');
  $('#repeatBtn').title = { off: '循环播放', all: '单曲循环', one: '关闭循环' }[P.repeat];
  $('#queueBtn').classList.toggle('on', panelMode === 'queue');
  setIcon($('#muteBtn'), audio.muted || audio.volume === 0 ? 'ic-mute' : 'ic-vol');
  vol.value = audio.muted ? 0 : Math.round(audio.volume * 100); paintSlider(vol);
  $$('[data-ctx-play]').forEach((b) => setIcon(b, isCtxPlaying(b.dataset.ctxPlay) ? 'ic-pause' : 'ic-play'));
}
function renderNowPlaying() {
  const t = S.tracks[P.current];
  $('#np').innerHTML = t ? `
    ${art(t.cover, t.album)}
    <div><a class="t" href="#/album/${enc((t.albumArtist || t.artist) + '\u0000' + t.album)}">${esc(t.title)}</a>
    <div class="s"><a href="#/artist/${enc(t.artist)}">${esc(t.artist)}</a></div></div>
    <button class="icon-btn like ${isLiked(t.id) ? 'on' : ''}" data-like="${t.id}" title="收藏"><i class="ic ${isLiked(t.id) ? 'ic-heart-on' : 'ic-heart'}"></i></button>` : '';
  $('#tDur').textContent = fmt(t?.duration || 0);
  $('.player').classList.toggle('idle', !t);
  renderControls();
  renderPanel();
}
function markPlaying() {
  $$('.tr[data-id]').forEach((r) => {
    const on = r.dataset.id === P.current;
    r.classList.toggle('playing', on);
    const n = $('.n span', r);
    if (n) n.innerHTML = on && !audio.paused ? '<span class="eq"><i></i><i></i><i></i></span>' : r.dataset.n;
  });
  $$('.lib-item .t').forEach((el) => el.classList.toggle('playing', el.closest('.lib-item').dataset.href === P.context?.href && !!P.current));
  renderControls();
}

// ---------- right panel ----------
let panelMode = localStorage.getItem('echo.panel') ?? 'np';
function setPanel(m) { panelMode = m; try { localStorage.setItem('echo.panel', m || ''); } catch {} $('.app').classList.toggle('no-panel', !m); renderPanel(); renderControls(); }
const isMobile = () => matchMedia('(max-width: 760px)').matches;
function openNp() { if (!P.current) return; $('.app').classList.add('np-open'); renderPanel(); }
function closeNp() { $('.app').classList.remove('np-open'); }
window.closeNp = closeNp;
function renderPanel() {
  const el = $('#panel');
  const mobileNp = isMobile() && $('.app').classList.contains('np-open');
  if (!panelMode && !mobileNp) return;
  if (mobileNp) {
    const t = S.tracks[P.current];
    if (!t) return closeNp();
    el.style.setProperty('--np-bg', `hsl(${hue(t.album)} 35% 28%)`);
    el.innerHTML = `<h3><button class="icon-btn" onclick="closeNp()" style="transform:rotate(-90deg)"><i class="ic ic-left"></i></button>
      <span style="font-size:13px;text-align:center;flex:1">${esc(P.context?.label || t.album)}</span><span style="width:32px"></span></h3>
      <div style="margin-top:4vh">${art(t.cover, t.album, 'art big-art')}</div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:5vh"><div style="flex:1;min-width:0">
        <div class="np-title" style="margin:0 0 4px">${esc(t.title)}</div><a class="muted" href="#/artist/${enc(t.artist)}">${esc(t.artist)}</a></div>
        <button class="icon-btn like ${isLiked(t.id) ? 'on' : ''}" data-like="${t.id}" style="width:44px;height:44px"><i class="ic ${isLiked(t.id) ? 'ic-heart-on' : 'ic-heart'}" style="width:26px;height:26px"></i></button></div>`;
    return;
  }
  const t = S.tracks[P.current];
  if (panelMode === 'queue') {
    const { manual, ctx } = upcoming();
    el.innerHTML = `<h3>播放队列 <button class="icon-btn" onclick="setPanel('np')"><i class="ic ic-close"></i></button></h3>
      ${t ? `<div class="label muted" style="font-size:13px;margin-bottom:6px">正在播放</div>${qItem(t, true)}` : '<p class="muted">还没有在播放的歌</p>'}
      ${manual.length ? `<div class="muted" style="font-size:13px;margin:18px 0 6px;display:flex;justify-content:space-between">接下来播放 <a href="#" onclick="P.upNext=[];renderPanel();return false" style="text-decoration:underline">清空</a></div>${manual.map((x, i) => qItem(x, false, `data-q="${i}"`)).join('')}` : ''}
      ${ctx.length ? `<div class="muted" style="font-size:13px;margin:18px 0 6px">接下来来自：${esc(P.context?.label || '队列')}</div>${ctx.slice(0, 50).map((x) => qItem(x)).join('')}` : ''}`;
    return;
  }
  if (!t) { el.innerHTML = `<div class="empty" style="padding:40px 8px"><i class="ic ic-note"></i><h3 style="font-size:18px">还没开始播放</h3><p>选一首歌开始吧</p></div>`; return; }
  const { manual, ctx } = upcoming();
  const nxt = manual[0] || ctx[0];
  el.innerHTML = `<h3>${esc(P.context?.label || t.album)} <button class="icon-btn" onclick="setPanel(null)" title="关闭"><i class="ic ic-close"></i></button></h3>
    ${art(t.cover, t.album, 'art big-art')}
    <div style="display:flex;align-items:center;gap:8px"><div style="flex:1;min-width:0">
      <div class="np-title">${esc(t.title)}</div><a class="muted" href="#/artist/${enc(t.artist)}">${esc(t.artist)}</a></div>
      <button class="icon-btn like ${isLiked(t.id) ? 'on' : ''}" data-like="${t.id}"><i class="ic ${isLiked(t.id) ? 'ic-heart-on' : 'ic-heart'}"></i></button></div>
    <div class="box"><h4>歌曲信息</h4>
      <div class="muted" style="font-size:14px;line-height:1.8">专辑：<a href="#/album/${enc((t.albumArtist || t.artist) + '\u0000' + t.album)}">${esc(t.album)}</a><br>
      ${t.year ? `年份：${esc(t.year)}<br>` : ''}${t.genre ? `风格：${esc(t.genre)}<br>` : ''}来源：${t.source === 'local' ? '本机文件' : t.source === 'nas' ? 'NAS' : `<a href="${esc(t.page || t.url)}" target="_blank" style="text-decoration:underline">Internet Archive</a>`}
      ${t.license ? `<br><span class="license">授权：<a href="${esc(t.license)}" target="_blank">${esc(licName(t.license))}</a></span>` : ''}</div></div>
    ${nxt ? `<div class="box"><h4 style="display:flex;justify-content:space-between">下一首 <a class="muted" href="#" onclick="setPanel('queue');return false" style="font-size:13px">打开队列</a></h4>${qItem(nxt)}</div>` : ''}`;
}
function qItem(t, now = false, extra = '') {
  return `<div class="q-item ${now ? 'now' : ''}" data-qplay="${t.id}" ${extra}>${art(t.cover, t.album)}<div><div class="t">${esc(t.title)}</div><div class="s">${esc(t.artist)}</div></div></div>`;
}
window.setPanel = setPanel; window.renderPanel = renderPanel; window.P = P;

// ---------- sidebar library ----------
let libFilter = 'all';
function renderLibrary() {
  const { albums, artists } = catalog();
  const chips = [['all', '全部'], ['pl', '歌单'], ['al', '专辑'], ['ar', '艺人']];
  $('#libChips').innerHTML = chips.map(([k, l]) => `<button class="chip ${libFilter === k ? 'on' : ''}" data-chip="${k}">${l}</button>`).join('');
  const items = [];
  if (libFilter === 'all' || libFilter === 'pl') {
    items.push({ href: '#/liked', html: `<div class="art" style="background:linear-gradient(135deg,#f2a93b,#8a3b12)"><i class="ic ic-heart-on" style="color:#fff"></i></div>`, t: '已收藏的歌曲', s: `歌单 · ${likedTracks().length} 首` });
    for (const p of S.playlists) items.push({ href: `#/playlist/${p.id}`, html: plCover(p), t: p.name, s: `歌单 · ${plTracks(p).length} 首` });
  }
  if (libFilter === 'all' || libFilter === 'al') for (const a of albums) items.push({ href: `#/album/${enc(a.key)}`, html: art(a.cover, a.title), t: a.title, s: `专辑 · ${a.artist}` });
  if (libFilter === 'all' || libFilter === 'ar') for (const a of artists) items.push({ href: `#/artist/${enc(a.name)}`, html: art(a.cover, a.name, 'art', 'ic-note'), t: a.name, s: '艺人', round: true });
  $('#libList').innerHTML = items.map((i) => `<div class="lib-item ${i.round ? 'round' : ''} ${location.hash === i.href ? 'active' : ''}" data-href="${i.href}">${i.html}<div><div class="t">${esc(i.t)}</div><div class="s">${esc(i.s)}</div></div></div>`).join('')
    || `<div class="empty" style="padding:24px 8px"><p>音乐库还是空的</p><a class="btn primary" href="#/import">添加音乐</a></div>`;
  markPlaying();
}

// ---------- track table ----------
function trackTable(tracks, { ctxHref, ctxLabel, showAlbum = true, showArt = true, playlistId = null, numbers = null } = {}) {
  if (!tracks.length) return '';
  const ids = tracks.map((t) => t.id);
  window.__ctx = { ids, ctxHref, ctxLabel };
  return `<div class="tracks" data-ctx="${esc(ctxHref)}" data-label="${esc(ctxLabel)}" data-ids="${ids.join(',')}" ${playlistId ? `data-pl="${playlistId}"` : ''}>
    <div class="tr head"><div class="n">#</div><div>标题</div><div>${showAlbum ? '专辑' : ''}</div><div></div><div class="dur">时长</div><div></div></div>
    ${tracks.map((t, i) => `<div class="tr" data-id="${t.id}" data-i="${i}" data-n="${numbers ? numbers[i] : i + 1}" ${playlistId ? 'draggable="true"' : ''}>
      <div class="n"><span>${numbers ? numbers[i] : i + 1}</span><i class="ic ic-play"></i></div>
      <div class="main-col">${showArt ? art(t.cover, t.album) : ''}<div style="min-width:0"><div class="title">${esc(t.title)}</div><div class="sub"><a href="#/artist/${enc(t.artist)}">${esc(t.artist)}</a></div></div></div>
      <div class="album">${showAlbum ? `<a href="#/album/${enc((t.albumArtist || t.artist) + '\u0000' + t.album)}">${esc(t.album)}</a>` : ''}</div>
      <button class="icon-btn like ${isLiked(t.id) ? 'on' : ''}" data-like="${t.id}" title="收藏"><i class="ic ${isLiked(t.id) ? 'ic-heart-on' : 'ic-heart'}"></i></button>
      <div class="dur">${fmt(t.duration)}</div>
      <button class="icon-btn more" data-more="${t.id}" title="更多"><i class="ic ic-more"></i></button>
    </div>`).join('')}</div>`;
}

function tile(o) {
  return `<div class="tile ${o.round ? 'round' : ''}" data-href="${o.href}"><div class="art-wrap">${o.art}
    ${o.play ? `<button class="play-big" data-ctx-play="${o.href}" data-play-ids="${o.play.join(',')}" data-play-label="${esc(o.t)}"><i class="ic ic-play"></i></button>` : ''}</div>
    <div class="t">${esc(o.t)}</div><div class="s">${esc(o.s)}</div></div>`;
}
const albumTile = (a) => tile({ href: `#/album/${enc(a.key)}`, art: art(a.cover, a.title), t: a.title, s: `${a.year ? a.year + ' · ' : ''}${a.artist}`, play: a.tracks.map((t) => t.id) });
const artistTile = (a) => tile({ href: `#/artist/${enc(a.name)}`, art: art(a.cover, a.name), t: a.name, s: '艺人', round: true, play: a.tracks.map((t) => t.id) });
const plTile = (p) => tile({ href: `#/playlist/${p.id}`, art: plCover(p), t: p.name, s: p.description || `${plTracks(p).length} 首歌`, play: plTracks(p).map((t) => t.id) });

function hero({ kind, title, cover, seed, meta, desc = '', round = false, icon = 'ic-note' }) {
  const h = hue(seed);
  return `<div class="hero ${round ? 'round' : ''}" style="--hero:hsl(${h} 40% 32%)">${typeof cover === 'string' && cover.startsWith('<') ? cover : art(cover, seed, 'art', icon)}
    <div style="min-width:0"><div class="kind">${kind}</div><h1>${esc(title)}</h1>${desc ? `<div class="desc">${esc(desc)}</div>` : ''}<div class="meta">${meta}</div></div></div>`;
}
function actions(ids, href, label, extra = '') {
  return `<div class="actions">${ids.length ? `<button class="play-big" data-ctx-play="${href}" data-play-ids="${ids.join(',')}" data-play-label="${esc(label)}"><i class="ic ic-play"></i></button>
    <button class="icon-btn" data-shuffle-play="${href}" data-play-ids="${ids.join(',')}" data-play-label="${esc(label)}" title="随机播放"><i class="ic ic-shuffle"></i></button>` : ''}${extra}</div>`;
}

// ---------- views ----------
const view = $('#view');
const routes = [
  [/^#?\/?$/, viewHome],
  [/^#\/search(?:\/(.*))?$/, viewSearch],
  [/^#\/library$/, viewLibrary],
  [/^#\/liked$/, viewLiked],
  [/^#\/playlist\/(.+)$/, viewPlaylist],
  [/^#\/album\/(.+)$/, viewAlbum],
  [/^#\/artist\/(.+)$/, viewArtist],
  [/^#\/archive(?:\/search\/(.*))?$/, viewArchive],
  [/^#\/ia\/(.+)$/, viewArchiveItem],
  [/^#\/(import|upload)$/, viewImport],
  [/^#\/settings$/, viewSettings],
];
let lastRoute = null;
async function route() {
  const h = location.hash || '#/';
  // a background refresh re-renders the same page: keep the scroll position and skip the entrance animation
  const samePage = h === lastRoute;
  lastRoute = h;
  const main = $('#main'), keepScroll = samePage ? main.scrollTop : 0;
  $$('a[data-nav]').forEach((a) => a.classList.toggle('active', (a.dataset.nav === 'home' && (h === '#/' || h === '')) || h.startsWith(`#/${a.dataset.nav}`) || (a.dataset.nav === 'library' && /^#\/(liked|playlist)/.test(h))));
  if (!samePage) closeNp();
  $('#searchBox').classList.toggle('hidden', !h.startsWith('#/search') && !h.startsWith('#/archive'));
  // the upload shortcut belongs to the home and library pages only; inner pages (playlist, album…) get a back button on phones
  const tabPage = /^#?\/?(search(\/.*)?|archive(\/search\/.*)?|library)?$/.test(h);
  $('#upBtn').classList.toggle('hidden', !/^#?\/?(library)?$/.test(h));
  $('#topbar').classList.toggle('sub', !tabPage);
  for (const [re, fn] of routes) {
    const m = h.match(re);
    if (m) { await fn(...m.slice(1).map((x) => (x ? decodeURIComponent(x) : x))); break; }
  }
  main.scrollTop = keepScroll;
  if (!samePage) { view.classList.remove('enter'); void view.offsetWidth; view.classList.add('enter'); }
  renderLibrary();
  markPlaying();
}
window.addEventListener('hashchange', route);

function viewHome() {
  const { albums, artists, tracks } = catalog();
  const hour = new Date().getHours();
  const greet = hour < 5 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';
  if (!tracks.length) {
    view.innerHTML = `<div class="view"><h1 class="page">${greet}</h1><div class="empty"><i class="ic ic-note"></i><h3>你的音乐库还是空的</h3>
      <p>导入手机或电脑里的音乐，连接你的 NAS，或者去免费曲库找点好听的。</p>
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap"><a class="btn primary" href="#/import">导入本机音乐</a><a class="btn ghost" href="#/settings">连接 NAS</a><a class="btn ghost" href="#/archive">逛逛免费曲库</a></div></div></div>`;
    return;
  }
  const recent = S.history.map((h) => S.tracks[h.id]).filter(Boolean);
  const shortcuts = [
    { href: '#/liked', art: `<div class="art" style="background:linear-gradient(135deg,#f2a93b,#8a3b12)"><i class="ic ic-heart-on" style="color:#fff"></i></div>`, t: '已收藏的歌曲', ids: likedTracks().map((t) => t.id) },
    ...S.playlists.map((p) => ({ href: `#/playlist/${p.id}`, art: plCover(p), t: p.name, ids: plTracks(p).map((t) => t.id) })),
    ...albums.slice(0, 8).map((a) => ({ href: `#/album/${enc(a.key)}`, art: art(a.cover, a.title), t: a.title, ids: a.tracks.map((t) => t.id) })),
  ].slice(0, 8);
  const newest = [...tracks].sort((a, b) => b.addedAt - a.addedAt);
  const newAlbums = [...albums].sort((a, b) => Math.max(...b.tracks.map((t) => t.addedAt)) - Math.max(...a.tracks.map((t) => t.addedAt)));
  view.innerHTML = `<div class="view"><h1 class="page">${greet}</h1>
    <div class="shortcuts">${shortcuts.map((s) => `<div class="shortcut" data-href="${s.href}">${s.art}<span>${esc(s.t)}</span>${s.ids.length ? `<button class="play-big" data-ctx-play="${s.href}" data-play-ids="${s.ids.join(',')}" data-play-label="${esc(s.t)}"><i class="ic ic-play"></i></button>` : ''}</div>`).join('')}</div>
    ${recent.length ? `<h2 class="sec">最近播放</h2><div class="compact">${trackTable(recent.slice(0, 5), { ctxHref: '#/recent', ctxLabel: '最近播放' })}</div>` : ''}
    <h2 class="sec">最新加入 <a href="#/library">显示全部</a></h2><div class="grid shelf">${newAlbums.slice(0, 8).map(albumTile).join('')}</div>
    <h2 class="sec">你的艺人</h2><div class="grid shelf">${artists.slice(0, 8).map(artistTile).join('')}</div>
    ${S.playlists.length ? `<h2 class="sec">你的歌单</h2><div class="grid shelf">${S.playlists.map(plTile).join('')}</div>` : ''}
    <h2 class="sec">全部歌曲</h2>${trackTable(newest, { ctxHref: '#/all', ctxLabel: '全部歌曲' })}</div>`;
}

const GENRES = [['流行', 'pop', 340], ['摇滚', 'rock', 10], ['爵士', 'jazz', 200], ['古典', 'classical', 260], ['电子', 'electronic', 290], ['民谣', 'folk', 30], ['氛围', 'ambient', 180], ['钢琴', 'piano', 220], ['Lo-fi', 'lofi', 120], ['蓝调', 'blues', 230], ['嘻哈', 'hip hop', 50], ['原声', 'acoustic', 90]];
let searchTimer;
function viewSearch(q = '') {
  const input = $('#searchInput');
  input.placeholder = '想听什么？';
  input.value = q;
  input.oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { history.replaceState(null, '', `#/search/${enc(input.value)}`); renderSearch(input.value); }, 150); };
  setTimeout(() => input.focus(), 0);
  renderSearch(q);
}
function norm(s) { return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, ''); }
function renderSearch(q) {
  q = norm(q).trim();
  if (!q) {
    view.innerHTML = `<div class="view"><h2 class="sec">浏览全部</h2><div class="genres">${GENRES.map(([n, k, h]) => `<a class="genre" href="#/archive/search/${enc(k)}" style="background:hsl(${h} 55% 40%)">${n}</a>`).join('')}</div>
      <p class="muted" style="margin-top:20px;font-size:14px">点类别会在免费曲库（Internet Archive）里搜索。</p></div>`;
    return;
  }
  const { tracks, albums, artists } = catalog();
  const words = q.split(/\s+/);
  const hit = (s) => words.every((w) => norm(s).includes(w));
  const tr = tracks.filter((t) => hit(`${t.title} ${t.artist} ${t.album}`));
  const al = albums.filter((a) => hit(`${a.title} ${a.artist}`));
  const ar = artists.filter((a) => hit(a.name));
  const pl = S.playlists.filter((p) => hit(p.name));
  const top = ar[0] ? { kind: '艺人', name: ar[0].name, href: `#/artist/${enc(ar[0].name)}`, cover: ar[0].cover, ids: ar[0].tracks.map((t) => t.id), round: true }
    : al[0] ? { kind: '专辑', name: al[0].title, href: `#/album/${enc(al[0].key)}`, cover: al[0].cover, ids: al[0].tracks.map((t) => t.id), sub: al[0].artist }
    : tr[0] ? { kind: '歌曲', name: tr[0].title, href: `#/album/${enc(tr[0].artist + '\u0000' + tr[0].album)}`, cover: tr[0].cover, ids: [tr[0].id], sub: tr[0].artist } : null;
  if (!top && !pl.length) {
    view.innerHTML = `<div class="view"><div class="empty"><h3>找不到“${esc(q)}”</h3><p>请检查拼写，或者换个关键词。</p>
      <a class="btn primary" href="#/archive/search/${enc(q)}">在免费曲库里搜索“${esc(q)}”</a></div></div>`;
    return;
  }
  view.innerHTML = `<div class="view">
    ${top ? `<div class="top-res"><div><h2 class="sec" style="margin-top:8px">最佳结果</h2>
      <div class="top-card" data-href="${top.href}">${art(top.cover, top.name, 'art')}<div class="t">${esc(top.name)}</div>
      <div class="muted" style="font-size:14px">${top.sub ? esc(top.sub) + ' · ' : ''}<span class="chip" style="color:var(--text);font-weight:700">${top.kind}</span></div>
      <button class="play-big" data-ctx-play="${top.href}" data-play-ids="${top.ids.join(',')}" data-play-label="${esc(top.name)}"><i class="ic ic-play"></i></button></div></div>
      <div><h2 class="sec" style="margin-top:8px">歌曲</h2><div class="compact">${trackTable(tr.slice(0, 4), { ctxHref: '#/search', ctxLabel: '搜索结果', showAlbum: false })}</div></div></div>` : ''}
    ${ar.length ? `<h2 class="sec">艺人</h2><div class="grid">${ar.slice(0, 6).map(artistTile).join('')}</div>` : ''}
    ${al.length ? `<h2 class="sec">专辑</h2><div class="grid">${al.slice(0, 6).map(albumTile).join('')}</div>` : ''}
    ${pl.length ? `<h2 class="sec">歌单</h2><div class="grid">${pl.map(plTile).join('')}</div>` : ''}
    ${tr.length > 4 ? `<h2 class="sec">全部歌曲</h2>${trackTable(tr, { ctxHref: '#/search', ctxLabel: '搜索结果' })}` : ''}
    <p class="muted" style="margin-top:24px;font-size:14px">没找到想要的？<a href="#/archive/search/${enc(q)}" style="text-decoration:underline">在免费曲库里搜索</a></p></div>`;
}

function viewLibrary() {
  const { albums, artists } = catalog();
  view.innerHTML = `<div class="view"><h1 class="page">音乐库</h1>
    <h2 class="sec">歌单</h2><div class="grid">${tile({ href: '#/liked', art: `<div class="art" style="background:linear-gradient(135deg,#f2a93b,#8a3b12)"><i class="ic ic-heart-on" style="color:#fff"></i></div>`, t: '已收藏的歌曲', s: `${likedTracks().length} 首`, play: likedTracks().map((t) => t.id) })}${S.playlists.map(plTile).join('')}</div>
    ${albums.length ? `<h2 class="sec">专辑</h2><div class="grid">${albums.map(albumTile).join('')}</div>` : ''}
    ${artists.length ? `<h2 class="sec">艺人</h2><div class="grid">${artists.map(artistTile).join('')}</div>` : ''}</div>`;
}

function viewLiked() {
  const tr = likedTracks();
  const dur = tr.reduce((a, t) => a + (t.duration || 0), 0);
  view.innerHTML = hero({ kind: '歌单', title: '已收藏的歌曲', cover: `<div class="art" style="background:linear-gradient(135deg,#f2a93b,#8a3b12)"><i class="ic ic-heart-on" style="color:#fff"></i></div>`, seed: 'liked', meta: `<b>你</b> · ${tr.length} 首歌${tr.length ? '，' + fmtLong(dur) : ''}` })
    + actions(tr.map((t) => t.id), '#/liked', '已收藏的歌曲')
    + (tr.length ? trackTable(tr, { ctxHref: '#/liked', ctxLabel: '已收藏的歌曲' }) : `<div class="empty"><i class="ic ic-heart"></i><h3>你收藏的歌会出现在这里</h3><p>点歌曲旁边的心形图标即可收藏。</p><a class="btn primary" href="#/search">找歌</a></div>`);
}

function viewPlaylist(id) {
  const p = S.playlists.find((x) => x.id === id);
  if (!p) { view.innerHTML = notFound(); return; }
  const tr = plTracks(p);
  const dur = tr.reduce((a, t) => a + (t.duration || 0), 0);
  view.innerHTML = hero({ kind: '歌单', title: p.name, cover: plCover(p), seed: p.name, desc: p.description, meta: `<b>你</b> · ${tr.length} 首歌${tr.length ? '，' + fmtLong(dur) : ''}` })
    + actions(tr.map((t) => t.id), `#/playlist/${p.id}`, p.name, `<button class="icon-btn" data-pl-menu="${p.id}" title="更多"><i class="ic ic-more"></i></button>`)
    + (tr.length ? trackTable(tr, { ctxHref: `#/playlist/${p.id}`, ctxLabel: p.name, playlistId: p.id }) : '')
    + `<div class="view" style="padding-top:${tr.length ? 8 : 24}px;border-top:${tr.length ? '1px solid var(--line)' : '0'}">
      <h2 class="sec" style="margin-top:16px">${tr.length ? '添加更多歌曲' : '来给你的歌单找些歌吧'}</h2>
      <div class="search-box" style="background:#2a2a2a"><i class="ic ic-search"></i><input id="plSearch" placeholder="搜索歌曲"></div>
      <div id="plResults" class="compact" style="margin-top:12px"></div></div>`;
  const input = $('#plSearch');
  const render = () => {
    const q = norm(input.value).trim();
    const inPl = new Set(p.items.map((i) => i.id));
    const pool = catalog().tracks.filter((t) => !inPl.has(t.id) && (!q || norm(`${t.title} ${t.artist} ${t.album}`).includes(q))).slice(0, q ? 20 : 8);
    $('#plResults').innerHTML = pool.length ? pool.map((t) => `<div class="tr" data-id="${t.id}" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto">
      <div class="main-col">${art(t.cover, t.album)}<div style="min-width:0"><div class="title">${esc(t.title)}</div><div class="sub">${esc(t.artist)}</div></div></div>
      <div class="album">${esc(t.album)}</div><button class="btn ghost" data-add-to="${p.id}" data-track="${t.id}">添加</button></div>`).join('')
      : `<p class="muted">${q ? '没有找到' : '音乐库里的歌都已经在这个歌单里了'}</p>`;
  };
  input.oninput = render;
  render();
}

function viewAlbum(key) {
  const a = catalog().albums.find((x) => x.key === key);
  if (!a) { view.innerHTML = notFound(); return; }
  const dur = a.tracks.reduce((s, t) => s + (t.duration || 0), 0);
  const type = a.tracks.length === 1 ? '单曲' : a.tracks.length <= 6 ? 'EP' : '专辑';
  const more = catalog().albums.filter((x) => x.artist === a.artist && x.key !== a.key);
  view.innerHTML = hero({ kind: type, title: a.title, cover: a.cover, seed: a.title, meta: `<a href="#/artist/${enc(a.artist)}"><b>${esc(a.artist)}</b></a>${a.year ? ' · ' + esc(a.year) : ''} · ${a.tracks.length} 首歌，${fmtLong(dur)}` })
    + actions(a.tracks.map((t) => t.id), `#/album/${enc(a.key)}`, a.title)
    + trackTable(a.tracks, { ctxHref: `#/album/${enc(a.key)}`, ctxLabel: a.title, showAlbum: false, showArt: false, numbers: a.tracks.map((t, i) => t.trackNo || i + 1) })
    + (more.length ? `<div class="view"><h2 class="sec">${esc(a.artist)} 的更多作品</h2><div class="grid shelf">${more.map(albumTile).join('')}</div></div>` : '');
}

function viewArtist(name) {
  const c = catalog();
  const a = c.artists.find((x) => x.name === name);
  if (!a) { view.innerHTML = notFound(); return; }
  const plays = new Map(S.history.map((h, i) => [h.id, 100 - i]));
  const popular = [...a.tracks].sort((x, y) => (plays.get(y.id) || 0) - (plays.get(x.id) || 0) || (isLiked(y.id) - isLiked(x.id)));
  const albums = c.albums.filter((x) => x.artist === name);
  view.innerHTML = hero({ kind: '艺人', title: a.name, cover: a.cover, seed: a.name, round: true, meta: `${a.tracks.length} 首歌 · ${albums.length} 张专辑` })
    + actions(popular.map((t) => t.id), `#/artist/${enc(name)}`, a.name)
    + `<div class="view" style="padding-top:0"><h2 class="sec" style="margin-top:0">热门</h2></div>`
    + trackTable(popular.slice(0, 10), { ctxHref: `#/artist/${enc(name)}`, ctxLabel: a.name })
    + `<div class="view"><h2 class="sec">作品</h2><div class="grid">${albums.map(albumTile).join('')}</div></div>`;
}

// Internet Archive
let iaCache = {};
async function viewArchive(q = '') {
  const input = $('#searchInput');
  input.placeholder = '搜索免费曲库（英文关键词效果更好）';
  input.value = q;
  input.oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { location.hash = `#/archive/search/${enc(input.value)}`; }, 500); };
  if (!q) {
    view.innerHTML = `<div class="view"><h1 class="page">免费曲库</h1>
      <p class="muted" style="max-width:640px;line-height:1.6">来自 <a href="https://archive.org/details/audio" target="_blank" style="text-decoration:underline">Internet Archive</a> 的公版和知识共享（CC）授权音乐，可以直接播放，喜欢的可以收藏到你的音乐库。</p>
      <h2 class="sec">选个风格</h2><div class="genres">${GENRES.map(([n, k, h]) => `<a class="genre" href="#/archive/search/${enc(k)}" style="background:hsl(${h} 55% 40%)">${n}</a>`).join('')}</div></div>`;
    setTimeout(() => input.focus(), 0);
    return;
  }
  view.innerHTML = `<div class="view"><h1 class="page">“${esc(q)}”</h1><div class="grid">${'<div class="tile"><div class="art skeleton"></div></div>'.repeat(8)}</div></div>`;
  try {
    const res = iaCache['s:' + q] ||= await api(`/api/archive/search?q=${enc(q)}`);
    if (location.hash !== `#/archive/search/${enc(q)}`) return;
    view.innerHTML = `<div class="view"><h1 class="page">“${esc(q)}”</h1>${res.length ? `<div class="grid">${res.map((r) => tile({ href: `#/ia/${enc(r.id)}`, art: art(r.cover, r.title), t: r.title, s: `${r.creator}${r.year ? ' · ' + r.year : ''}` })).join('')}</div>`
      : '<div class="empty"><h3>没有找到</h3><p>试试英文关键词，比如 piano、jazz、guitar。</p></div>'}</div>`;
  } catch { view.innerHTML = `<div class="view"><div class="empty"><h3>连不上 Internet Archive</h3><p>检查一下网络，稍后再试。</p></div></div>`; }
}
function licName(u) {
  if (!u) return '';
  const m = u.match(/licenses\/([a-z-]+)\/?([\d.]*)/i);
  if (m) return `CC ${m[1].toUpperCase()} ${m[2]}`.trim();
  if (/publicdomain/i.test(u)) return '公有领域';
  return u.replace(/^https?:\/\//, '');
}
async function viewArchiveItem(id) {
  view.innerHTML = `<div class="hero"><div class="art skeleton"></div><div><div class="skeleton" style="width:300px;height:60px"></div></div></div>`;
  try {
    const it = iaCache['i:' + id] ||= await api(`/api/archive/item/${enc(id)}`);
    // register tracks so the player, likes and playlists can use them
    const saved = await Promise.all(it.tracks.map((t) => api('/api/tracks', { method: 'POST', body: { ...t, albumArtist: it.creator, cover: it.cover, year: it.year, license: it.license, page: it.page, album: t.album || it.title } })));
    const ids = saved.map((t) => t.id);
    const dur = saved.reduce((s, t) => s + (t.duration || 0), 0);
    view.innerHTML = hero({ kind: '免费曲库', title: it.title, cover: it.cover, seed: it.title, desc: it.description.slice(0, 200), meta: `<b>${esc(it.creator)}</b>${it.year ? ' · ' + esc(it.year) : ''} · ${saved.length} 首歌${dur ? '，' + fmtLong(dur) : ''}` })
      + actions(ids, `#/ia/${enc(id)}`, it.title, `<a class="btn ghost" href="${esc(it.page)}" target="_blank">在 archive.org 打开</a>`)
      + `<div style="padding:0 24px 12px" class="license">${it.license ? `授权：<a href="${esc(it.license)}" target="_blank">${esc(licName(it.license))}</a>` : '授权信息见 archive.org 页面'}</div>`
      + (saved.length ? trackTable(saved, { ctxHref: `#/ia/${enc(id)}`, ctxLabel: it.title, showAlbum: false, showArt: false }) : '<div class="empty"><h3>这个条目没有可播放的 MP3</h3></div>');
    renderLibrary();
  } catch { view.innerHTML = `<div class="view"><div class="empty"><h3>加载失败</h3><p>连不上 Internet Archive，稍后再试。</p></div></div>`; }
}

const noFolderPicker = /iPhone|iPad|iPod/.test(navigator.userAgent) || !('webkitdirectory' in document.createElement('input'));
function viewImport() {
  const folders = [...new Set(S.playlists.filter((p) => String(p.source || '').startsWith('local:')).map((p) => p.source.slice(6)))];
  view.innerHTML = `<div class="view"><h1 class="page">导入本机音乐</h1>
    <div class="note" style="margin:0 0 16px"><label for="upFolder"><b style="color:var(--text)">放进歌单（可选）</b></label><br>
      填了名字，这次导入的歌会放进同名歌单。选整个文件夹导入时，每个文件夹自动变成一个歌单。<br>
      <input id="upFolder" list="upFolders" maxlength="100" placeholder="例如：周末歌单" style="margin-top:10px;width:min(360px,100%);background:#2a2a2a;border:1px solid #3e3e3e;border-radius:6px;padding:10px 12px;color:var(--text)">
      <datalist id="upFolders">${folders.map((f) => `<option value="${esc(f)}">`).join('')}</datalist></div>
    <label class="drop" id="drop"><input type="file" id="fileInput" multiple accept="audio/*,.mp3,.m4a,.flac,.wav,.ogg,.opus" hidden>
      <i class="ic ic-up"></i><h3>${touchUI.matches ? '点这里选择音乐文件' : '把音乐文件拖到这里'}</h3><p>${touchUI.matches ? '可以一次选多首' : '或者点击选择文件'}。歌会保存在这台设备上，不会上传到任何地方。</p>
      <div class="progress hidden" id="prog"><div></div></div><p id="upMsg"></p></label>
    ${noFolderPicker ? '' : `<div style="margin-top:12px"><label class="btn ghost" style="cursor:pointer"><input type="file" id="dirInput" webkitdirectory multiple hidden><i class="ic ic-folder"></i>导入整个文件夹</label></div>`}
    <div class="note">支持 MP3、M4A、FLAC、WAV、OGG。歌名、歌手、专辑、封面从文件标签读取；没有标签的话，用文件名 <code>歌手 - 歌名.mp3</code>。<br>
    iPhone：「文件」App 里的歌都能选，包括 iCloud 云盘里的。<br>
    歌存在这个浏览器的存储里：换手机或清除浏览器数据后要重新导入。歌很多的话，建议放在 NAS 上，在<a href="#/settings" style="text-decoration:underline">设置</a>里连接。</div></div>`;
  const drop = $('#drop'), input = $('#fileInput');
  input.onchange = () => importFiles([...input.files]);
  if ($('#dirInput')) $('#dirInput').onchange = (e) => importFiles([...e.target.files], true);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); importFiles([...e.dataTransfer.files]); };
}
async function importFiles(files, fromDir = false) {
  const prog = $('#prog');
  prog.classList.remove('hidden');
  $('#upMsg').textContent = '正在读取歌曲信息…';
  try {
    const r = await Store.importFiles(files, {
      folder: fromDir ? '' : $('#upFolder')?.value || '',
      onProgress: (done, total) => { $('div', prog).style.width = `${(done / total) * 100}%`; $('#upMsg').textContent = `正在导入 ${done}/${total}…`; },
    });
    if (!r.added && !r.skipped) { $('#upMsg').textContent = ''; prog.classList.add('hidden'); return toast('没有可以导入的音乐文件'); }
    $('#upMsg').textContent = `完成：导入了 ${r.added} 首${r.skipped ? `，${r.skipped} 首已经在音乐库里` : ''}`;
    toast(`已添加 ${r.added} 首歌`);
  } catch (e) {
    console.error(e);
    $('#upMsg').textContent = e?.name === 'QuotaExceededError' ? '设备存储空间不够了，删掉一些歌再试' : '导入失败：' + (e?.message || e);
  }
}

const NAS_ERRORS = {
  nas_needs_https: 'NAS 地址必须是 https:// 开头（浏览器不允许 https 网页连接 http 地址）。可以用群晖 DDNS + 证书、Tailscale，或者反向代理。',
  nas_unreachable: '连不上这个地址。检查地址和端口，确认 NAS 开着，并且服务器允许跨域（CORS）。',
  nas_not_subsonic: '这个地址不是 Subsonic 服务器。请填 Navidrome 等服务的网址，例如 https://music.example.com',
  nas_wrong_login: '用户名或密码不对。',
  nas_token_unsupported: '这个服务器不支持令牌登录（常见于 LDAP 账号），请换一个本地账号。',
};
const nasError = (e) => NAS_ERRORS[e?.message] || (String(e?.message || e).startsWith('nas_http_') ? `服务器返回错误 ${e.message.slice(9)}` : `出错了：${e?.message || e}`);
async function runNasSync(quiet = false) {
  if (!Store.nas) return;
  try {
    const r = await Store.nasSync((p) => { if (!quiet) toast(p.phase === 'songs' ? `正在读取 NAS 的歌… ${p.count}` : `正在读取 NAS 歌单 ${p.done}/${p.total}`); });
    if (!quiet && r) toast(`NAS：${r.songs} 首歌，${r.playlists} 个歌单`);
  } catch (e) { if (!quiet) toast(nasError(e)); else console.warn('nas sync failed', e); }
}

async function viewSettings() {
  const info = await Store.storageInfo();
  const mb = (b) => `${(b / 1024 / 1024).toFixed(b > 100 * 1024 * 1024 ? 0 : 1)} MB`;
  const nasCount = Object.values(S.tracks).filter((t) => t.source === 'nas').length;
  const field = 'width:100%;background:#2a2a2a;border:1px solid #3e3e3e;border-radius:6px;padding:10px 12px;color:var(--text);margin-top:8px;font-size:16px';
  view.innerHTML = `<div class="view"><h1 class="page">设置</h1>
    <h2 class="sec">本机音乐</h2>
    <div class="note" style="margin-top:0">这台设备上有 ${info.count} 首歌，占用 ${mb(info.used)}${info.quota ? `（浏览器最多可用约 ${mb(info.quota)}）` : ''}。${info.persisted ? '' : '<br>提示：把 Echo 装到手机桌面后，存储更稳定，系统不会自动清理。'}
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:12px"><a class="btn primary" href="#/import">导入音乐</a>${info.count ? '<button class="btn ghost" id="clearLocal">删除本机所有歌</button>' : ''}</div></div>

    <h2 class="sec">NAS（Subsonic / Navidrome）</h2>
    ${Store.nas ? `<div class="note" style="margin-top:0">已连接 <b style="color:var(--text)">${esc(Store.nas.url)}</b>（${esc(Store.nas.user)}），${nasCount} 首歌。
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:12px"><button class="btn primary" id="nasSync">立即同步</button><button class="btn ghost" id="nasOff">断开连接</button></div></div>`
    : `<form class="note" id="nasForm" style="margin-top:0;max-width:520px">
      在 NAS 上装 <a href="https://www.navidrome.org/docs/installation/" target="_blank" style="text-decoration:underline">Navidrome</a>（群晖、威联通、Unraid 都能用 Docker 装），或者其他兼容 Subsonic 的服务。连上后会读取 NAS 上所有的歌和歌单，边下边播。
      <input name="url" required placeholder="服务器地址，例如 https://music.example.com" inputmode="url" autocomplete="url" autocapitalize="off" style="${field};margin-top:14px">
      <input name="user" required placeholder="用户名" autocomplete="username" autocapitalize="off" style="${field}">
      <input name="password" type="password" required placeholder="密码" autocomplete="current-password" style="${field}">
      <p id="nasMsg" style="color:#f28b82;min-height:1.2em;margin:10px 0 0"></p>
      <button class="btn primary" id="nasBtn" style="margin-top:4px">连接</button>
      <p style="font-size:13px;margin:12px 0 0">密码不会被保存，只保存一个登录令牌，而且只存在这台设备上。地址必须是 https://（http 只能在本机测试时用）。</p></form>`}

    <h2 class="sec">装到手机桌面</h2>
    <div class="note" style="margin-top:0">iPhone：用 Safari 打开这个网址 → 点底部的「分享」→「添加到主屏幕」。<br>Android：点下面的按钮，或 Chrome 菜单 →「安装应用」。<br>从主屏幕打开时没有浏览器地址栏，画面会铺满整个屏幕。
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin:12px 0">${installPrompt ? '<button class="btn primary" id="installBtn">安装到手机桌面</button>' : ''}${canFullscreen ? `<button class="btn ghost" id="fsBtn">${document.fullscreenElement ? '退出全屏' : '全屏显示'}</button>` : ''}</div>
      <span style="font-size:12px;opacity:.7">${esc(screenInfo())}</span></div></div>`;
  if ($('#nasForm')) $('#nasForm').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target), btn = $('#nasBtn');
    btn.disabled = true; btn.textContent = '正在连接…'; $('#nasMsg').textContent = '';
    try {
      const r = await Store.nasConnect({ url: fd.get('url'), user: fd.get('user'), password: fd.get('password') });
      S = Store.state;
      toast(`已连接：${r.songs} 首歌，${r.playlists} 个歌单`);
      viewSettings();
    } catch (err) {
      $('#nasMsg').textContent = nasError(err);
      btn.disabled = false; btn.textContent = '连接';
    }
  };
  if ($('#nasSync')) $('#nasSync').onclick = async () => { await runNasSync(); viewSettings(); };
  if ($('#nasOff')) $('#nasOff').onclick = () => {
    if (!confirm('断开 NAS？NAS 上的歌和歌单会从这台设备的音乐库里移除（NAS 上的文件不受影响）。')) return;
    if (S.tracks[P.current]?.source === 'nas') { audio.pause(); audio.removeAttribute('src'); P.current = null; renderNowPlaying(); }
    Store.nasDisconnect(); S = Store.state; viewSettings();
  };
  if ($('#clearLocal')) $('#clearLocal').onclick = async () => {
    if (!confirm(`删除这台设备上的全部 ${info.count} 首歌？原来的音乐文件不受影响，之后可以重新导入。`)) return;
    const ids = Object.values(S.tracks).filter((t) => t.source === 'local').map((t) => t.id);
    if (ids.includes(P.current)) { audio.pause(); audio.removeAttribute('src'); P.current = null; renderNowPlaying(); }
    await Store.deleteLocal(ids); S = Store.state; toast('已删除'); viewSettings();
  };
  if ($('#installBtn')) $('#installBtn').onclick = async () => {
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    installPrompt = null;
    if (outcome === 'accepted') { $('#installBtn')?.remove(); toast('已安装，可以从桌面打开了'); }
  };
  if ($('#fsBtn')) $('#fsBtn').onclick = () => { toggleFullscreen(); setTimeout(() => { if ($('#fsBtn')) $('#fsBtn').textContent = document.fullscreenElement ? '退出全屏' : '全屏显示'; }, 300); };
}

const notFound = () => `<div class="view"><div class="empty"><h3>找不到这个页面</h3><p>它可能已经被删除了。</p><a class="btn primary" href="#/">回首页</a></div></div>`;

// ---------- menus, modals, toasts ----------
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200); }
const menu = $('#menu');
function openMenu(x, y, html) {
  menu.innerHTML = html;
  menu.classList.remove('hidden');
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
}
const closeMenu = () => menu.classList.add('hidden');
document.addEventListener('click', (e) => { if (!menu.contains(e.target) && !e.target.closest('[data-more],[data-pl-menu]')) closeMenu(); });

function trackMenu(id, x, y, plId) {
  const t = S.tracks[id];
  if (!t) return;
  openMenu(x, y, `
    <button data-m="queue">加入播放队列</button>
    <button data-m="like">${isLiked(id) ? '取消收藏' : '收藏到“已收藏的歌曲”'}</button>
    <hr><div class="label">添加到歌单</div>
    <button data-m="newpl">+ 新建歌单</button>
    ${S.playlists.map((p) => `<button data-m="add" data-pl="${p.id}">${esc(p.name)}</button>`).join('')}
    ${plId ? `<hr><button data-m="rmpl">从这个歌单移除</button>` : ''}
    ${t.source === 'local' ? '<hr><button data-m="dellocal">从这台设备删除</button>' : ''}
    <hr><a href="#/artist/${enc(t.artist)}">前往艺人</a><a href="#/album/${enc((t.albumArtist || t.artist) + '\u0000' + t.album)}">前往专辑</a>
`);
  menu.onclick = async (e) => {
    const b = e.target.closest('[data-m]');
    if (!b && e.target.closest('a')) return closeMenu();
    if (!b) return;
    closeMenu();
    const m = b.dataset.m;
    if (m === 'queue') addToQueue(id);
    if (m === 'like') toggleLike(id);
    if (m === 'add') addToPlaylist(b.dataset.pl, id);
    if (m === 'newpl') { const p = await api('/api/playlists', { method: 'POST', body: {} }); await addToPlaylist(p.id, id); renderLibrary(); }
    if (m === 'dellocal' && confirm(`从这台设备删除“${t.title}”？它也会从所有歌单里移除。`)) {
      if (P.current === id) { audio.pause(); audio.removeAttribute('src'); P.current = null; renderNowPlaying(); }
      await Store.deleteLocal([id]); S = Store.state; toast('已删除'); route();
    }
    if (m === 'rmpl') {
      const p = S.playlists.find((x) => x.id === plId);
      const idx = p.items.findIndex((i) => i.id === id);
      p.items.splice(idx, 1);
      await api(`/api/playlists/${p.id}`, { method: 'PATCH', body: { items: p.items } });
      toast(`已从“${p.name}”移除`); route();
    }
  };
}
async function addToPlaylist(plId, id) {
  const p = S.playlists.find((x) => x.id === plId);
  if (p.items.some((i) => i.id === id) && !confirm(`这首歌已经在“${p.name}”里了，还要再加一次吗？`)) return;
  const np = await api(`/api/playlists/${plId}/items`, { method: 'POST', body: { id } });
  Object.assign(p, np);
  toast(`已添加到“${p.name}”`);
  renderLibrary();
  if (location.hash === `#/playlist/${plId}`) route();
}
async function toggleLike(id) {
  const r = await api(`/api/likes/${id}`, { method: 'POST' });
  toast(r.liked ? '已收藏到“已收藏的歌曲”' : '已从“已收藏的歌曲”移除');
  $$(`[data-like="${id}"]`).forEach((b) => { b.classList.toggle('on', r.liked); b.innerHTML = `<i class="ic ${r.liked ? 'ic-heart-on' : 'ic-heart'}"></i>`; });
  renderLibrary();
  if (location.hash === '#/liked') route();
}
function playlistMenu(plId, x, y) {
  const p = S.playlists.find((q) => q.id === plId);
  openMenu(x, y, `<button data-m="edit">编辑详情</button><button data-m="queue">全部加入播放队列</button><hr><button data-m="del">删除歌单</button>`);
  menu.onclick = async (e) => {
    const b = e.target.closest('[data-m]'); if (!b) return; closeMenu();
    if (b.dataset.m === 'edit') editPlaylist(p);
    if (b.dataset.m === 'queue') { plTracks(p).forEach((t) => P.upNext.push(t.id)); toast('已加入播放队列'); }
    if (b.dataset.m === 'del' && confirm(`删除“${p.name}”？这会把它从你的音乐库移除（歌曲本身不会被删除）。`)) {
      await api(`/api/playlists/${p.id}`, { method: 'DELETE' });
      toast('歌单已删除'); location.hash = '#/library';
    }
  };
}
function editPlaylist(p) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<form class="modal"><h2>编辑详情 <button type="button" class="icon-btn" data-x><i class="ic ic-close"></i></button></h2>
    <input name="name" value="${esc(p.name)}" maxlength="100" placeholder="歌单名称" required>
    <textarea name="description" rows="3" maxlength="300" placeholder="添加描述（可选）">${esc(p.description)}</textarea>
    <div class="row"><button class="btn primary">保存</button></div></form>`;
  document.body.append(bg);
  $('input', bg).select();
  bg.onclick = (e) => { if (e.target === bg || e.target.closest('[data-x]')) bg.remove(); };
  $('form', bg).onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    Object.assign(p, await api(`/api/playlists/${p.id}`, { method: 'PATCH', body: { name: fd.get('name'), description: fd.get('description') } }));
    bg.remove(); route();
  };
}

// one delegated click handler for everything clickable
document.addEventListener('click', async (e) => {
  const el = e.target;
  const like = el.closest('[data-like]');
  if (like) { e.stopPropagation(); return toggleLike(like.dataset.like); }
  const more = el.closest('[data-more]');
  if (more) { e.stopPropagation(); const r = more.getBoundingClientRect(); return trackMenu(more.dataset.more, r.left - 160, r.bottom, more.closest('[data-pl]')?.dataset.pl); }
  const plm = el.closest('[data-pl-menu]');
  if (plm) { const r = plm.getBoundingClientRect(); return playlistMenu(plm.dataset.plMenu, r.left, r.bottom); }
  const cp = el.closest('[data-ctx-play]');
  if (cp) { e.stopPropagation(); e.preventDefault(); return playCtx(cp.dataset.playIds.split(',').filter(Boolean), cp.dataset.ctxPlay, cp.dataset.playLabel); }
  const sp = el.closest('[data-shuffle-play]');
  if (sp) { P.shuffle = true; const ids = sp.dataset.playIds.split(','); return playList(ids, Math.floor(Math.random() * ids.length), { href: sp.dataset.shufflePlay, label: sp.dataset.playLabel }); }
  const add = el.closest('[data-add-to]');
  if (add) return addToPlaylist(add.dataset.addTo, add.dataset.track);
  const qp = el.closest('[data-qplay]');
  if (qp) {
    const id = qp.dataset.qplay;
    if (qp.dataset.q !== undefined) { P.upNext.splice(+qp.dataset.q, 1); return loadTrack(id, true); }
    const i = P.order.findIndex((k, j) => j > P.pos && P.queue[k] === id);
    if (i > -1) { P.pos = i; return loadTrack(id, true); }
    return;
  }
  const chip = el.closest('[data-chip]');
  if (chip) { libFilter = chip.dataset.chip; return renderLibrary(); }
  const row = el.closest('.tr[data-id]');
  if (row && !el.closest('a,button')) {
    const box = row.closest('.tracks');
    if (!box) return;
    const ids = box.dataset.ids.split(',');
    const i = +row.dataset.i;
    // phones: one tap plays; desktop: double click (single click selects)
    if (e.detail >= 2 || el.closest('.n') || touchUI.matches) return playList(ids, i, { href: box.dataset.ctx, label: box.dataset.label });
    $$('.tr.sel').forEach((r) => r.classList.remove('sel'));
    row.classList.add('sel');
    return;
  }
  const nav = el.closest('[data-href]');
  if (nav && !el.closest('a,button')) location.hash = nav.dataset.href;
});
$('#np').addEventListener('click', (e) => {
  if (!isMobile() || e.target.closest('[data-like]')) return;
  e.preventDefault(); e.stopPropagation(); openNp();
}, true);
document.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.tr[data-id]');
  if (row && row.closest('.tracks')) { e.preventDefault(); trackMenu(row.dataset.id, e.clientX, e.clientY, row.closest('[data-pl]')?.dataset.pl); }
});
$('#newPlaylist').onclick = async () => {
  const p = await api('/api/playlists', { method: 'POST', body: {} });
  location.hash = `#/playlist/${p.id}`;
};

// drag to reorder inside a playlist
let dragFrom = null;
document.addEventListener('dragstart', (e) => { const r = e.target.closest?.('.tr[draggable]'); if (r) { dragFrom = +r.dataset.i; r.classList.add('dragging'); } });
document.addEventListener('dragover', (e) => {
  const r = e.target.closest?.('.tr[draggable]');
  if (dragFrom === null || !r) return;
  e.preventDefault();
  $$('.drop-above').forEach((x) => x.classList.remove('drop-above'));
  r.classList.add('drop-above');
});
document.addEventListener('drop', async (e) => {
  const r = e.target.closest?.('.tr[draggable]');
  if (dragFrom === null || !r) return;
  e.preventDefault();
  const to = +r.dataset.i;
  const p = S.playlists.find((x) => x.id === r.closest('[data-pl]').dataset.pl);
  const [m] = p.items.splice(dragFrom, 1);
  p.items.splice(to > dragFrom ? to - 1 : to, 0, m);
  dragFrom = null;
  await api(`/api/playlists/${p.id}`, { method: 'PATCH', body: { items: p.items } });
  route();
});
document.addEventListener('dragend', () => { dragFrom = null; $$('.dragging,.drop-above').forEach((x) => x.classList.remove('dragging', 'drop-above')); });

// keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input,textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  if (e.code === 'ArrowRight' && e.shiftKey) next();
  else if (e.code === 'ArrowRight') audio.currentTime += 5;
  if (e.code === 'ArrowLeft' && e.shiftKey) prev();
  else if (e.code === 'ArrowLeft') audio.currentTime -= 5;
  if (e.key === '/') { e.preventDefault(); location.hash = '#/search'; }
});

// ---------- fit the screen ----------
// Track the real screen height ourselves when CSS can't:
// - older phones without dvh units
// - iPhone home-screen apps: iOS reports a height minus the status bar and home indicator,
//   while still drawing from the very top, which leaves a black strip at the bottom
const iosApp = navigator.standalone === true;
if (iosApp || !CSS.supports('height', '100dvh')) {
  const fit = () => {
    let h = window.visualViewport?.height || innerHeight;
    if (iosApp) {
      const land = matchMedia('(orientation: landscape)').matches;
      h = Math.max(h, land ? Math.min(screen.width, screen.height) : Math.max(screen.width, screen.height));
    }
    document.documentElement.style.setProperty('--app-h', `${h}px`);
  };
  fit();
  (window.visualViewport || window).addEventListener('resize', fit);
  addEventListener('orientationchange', () => setTimeout(fit, 300));
}
const standalone = matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || navigator.standalone;
const canFullscreen = !standalone && document.fullscreenEnabled;
// the home-indicator gap only belongs to home-screen mode; inside a browser its own toolbar already covers it
document.documentElement.classList.toggle('standalone', !!standalone);
function screenInfo() {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom);visibility:hidden';
  document.body.append(probe);
  const cs = getComputedStyle(probe), info = `屏幕 ${screen.width}×${screen.height}，可见 ${innerWidth}×${innerHeight}，安全区 上${parseInt(cs.paddingTop)} 下${parseInt(cs.paddingBottom)}，${standalone ? '主屏幕模式' : '浏览器模式'}`;
  probe.remove();
  return info;
}
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => toast('这个浏览器不支持全屏'));
}

// ---------- install as an app ----------
// Android Chrome / Edge offer a real install dialog; keep it for the button in settings
let installPrompt = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });
// offline shell + instant reopen; also what Android needs to treat the site as an installable app
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

// swipe down on the full screen player to close it (phones)
{
  const panel = $('#panel');
  let y0 = null, dy = 0;
  panel.addEventListener('touchstart', (e) => {
    if (!$('.app').classList.contains('np-open') || panel.scrollTop > 0) return;
    y0 = e.touches[0].clientY; dy = 0;
  }, { passive: true });
  panel.addEventListener('touchmove', (e) => {
    if (y0 === null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    panel.style.transition = 'none';
    panel.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  panel.addEventListener('touchend', () => {
    if (y0 === null) return;
    y0 = null;
    panel.style.transition = '';
    panel.style.transform = '';
    if (dy > 120) closeNp();
  });
}

// ---------- boot ----------
async function refresh() { S = Store.state; renderLibrary(); renderNowPlaying(); await route(); }
let rerenderTimer;
Store.onChange((state) => {
  S = state;
  clearTimeout(rerenderTimer);
  // don't wipe what the user is typing or a half-filled form
  rerenderTimer = setTimeout(() => { renderLibrary(); renderNowPlaying(); if (!document.activeElement?.closest('input,textarea') && !/^#\/(import|upload|settings)/.test(location.hash)) route(); }, 300);
});
(async () => {
  await Store.init();
  S = Store.state;
  restorePlayer();
  setPanel(panelMode || null);
  renderNowPlaying();
  await route();
  runNasSync(true); // pick up new songs and playlists on the NAS quietly
})();
