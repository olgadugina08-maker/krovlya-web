/* Service worker: офлайн-работа калькулятора (PWA) */
const CACHE_NAME = 'krovlya-app-shell-22';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/materials.js',
  './js/core.js',
  './js/templates.js',
  './js/canvas.js',
  './js/exportXLS.js',
  './js/exportPDF.js',
  './js/dwgImport.js',
  './js/shapeLibrary.js',
  './js/app.js',
  './vendor/libredwg/libredwg-web-glue.js',
  './vendor/libredwg/libredwg-web.umd.js',
  './vendor/libredwg/libredwg-wasm-gzip.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (key) {
          return key === CACHE_NAME ? null : caches.delete(key);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Сторонние ресурсы (например, шрифты Google) не кешируем.
  if (url.origin !== self.location.origin) return;

  // Страницы: сначала сеть, при отсутствии — кеш (офлайн).
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(function (response) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(request, copy); });
          return response;
        })
        .catch(function () {
          return caches.match(request).then(function (hit) {
            return hit || caches.match('./index.html');
          });
        })
    );
    return;
  }

  // Остальные файлы: из кеша сразу, обновление — в фоне.
  event.respondWith(
    caches.match(request).then(function (cached) {
      const network = fetch(request)
        .then(function (response) {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(function (cache) { cache.put(request, copy); });
          }
          return response;
        })
        .catch(function () { return cached; });
      return cached || network;
    })
  );
});
