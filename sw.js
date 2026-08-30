const CACHE_PREFIX = 'teleprompter-shell-';
const CACHE_NAME = `${CACHE_PREFIX}v3`;
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/platform-controls.js',
  './js/reader-controller.js',
  './js/scroll-engine.js',
  './js/settings-store.js',
  './js/teleprompter-model.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== self.location.origin) return;

  event.respondWith((async () => {
    let cached;
    try {
      cached = await caches.match(request, { ignoreSearch: true });
    } catch {
      cached = undefined;
    }
    if (cached) return cached;

    try {
      const response = await fetch(request);
      if (response?.ok && response.type !== 'opaque') {
        try {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, response.clone());
        } catch {
          // A successful network response stays usable if Cache Storage is unavailable.
        }
      }
      return response;
    } catch (error) {
      if (request.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      return Response.error();
    }
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
