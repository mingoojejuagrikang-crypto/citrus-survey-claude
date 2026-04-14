// sw.js – 감귤 조사 PWA 서비스 워커 (cache-first app shell)
const CACHE_NAME = 'citrus-survey-v3';

const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './parser.js',
  './field-config.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // HuggingFace / CDN 요청은 SW 밖으로 패스
  if (e.request.url.includes('huggingface.co') ||
      e.request.url.includes('cdn-lfs') ||
      e.request.url.includes('googleapis')) {
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request)
        .then(resp => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          }
          return resp;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
