// Service worker: makes Echo open instantly and work as an installed app on iOS and Android.
// Only the app shell (HTML/CSS/JS/icons) is cached. API calls and music (R2, Internet Archive)
// always go to the network, so nothing private is stored here.
const CACHE = 'echo-shell-v1';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/store.js', '/id3.js', '/manifest.json',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // network first so a new deploy is picked up right away (no mix of old and new files);
  // the cache is the fallback when offline or on a dead connection
  const key = req.mode === 'navigate' ? '/index.html' : req;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(key, res.clone());
      return res;
    } catch {
      return (await cache.match(key)) || Response.error();
    }
  }));
});
