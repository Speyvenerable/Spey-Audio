/* SPEY//AUDIO service worker: caches the app shell so it opens offline.
   Audio files live in IndexedDB (not here). */
const CACHE = 'spey-audio-v4';
const ASSETS = ['./', './index.html', './style.css', './app.js', './manifest.json', './icon.svg', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(ASSETS.map(a => c.add(a).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin !== location.origin) return; // never touch audio downloads from other sites

  e.respondWith(
    fetch(r)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(r, copy));
        }
        return res;
      })
      .catch(() => caches.match(r).then(m => m || caches.match('./index.html')))
  );
});
