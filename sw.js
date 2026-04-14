const CACHE_NAME = 'citrus-voice-v2';

self.addEventListener('install', e => {
  const base = self.registration.scope;
  const ASSETS = [
    base,
    base + 'index.html',
    base + 'app.js',
    base + 'style.css',
    base + 'manifest.json',
    base + 'icon-192.png',
    base + 'icon-512.png'
  ];
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).catch(() => caches.match(self.registration.scope + 'index.html'));
    })
  );
});
