const CACHE_PREFIX = 'teleprompter-shell-';
const CACHE_NAME = `${CACHE_PREFIX}v5`;
const MODEL_PATH = './vendor/vosk-model-small-ru-0.22.tar.gz';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/studio.js',
  './js/take-library.js',
  './js/capture-session.js',
  './js/speech-input.js',
  './js/speech-model-cache.js',
  './js/speech-processor.js',
  './js/voice-match.js',
  './js/voice-scroll.js',
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
    // Bypass HTTP cache so a recently used v4 module cannot enter the v5 shell.
    caches.open(CACHE_NAME).then((cache) => cache.addAll(
      APP_SHELL.map(path => new Request(new URL(path, self.location.href), { cache: 'reload' })),
    )),
  );
});

async function activate() {
  const names = await caches.keys();
  if (names.includes('teleprompter-shell-v4')) {
    // v4 stored this immutable archive alongside the shell. Reuse the first download.
    try {
      const model = await caches.match(MODEL_PATH, { cacheName: 'teleprompter-shell-v4' });
      if (model) {
        const models = await caches.open('teleprompter-voice-models');
        await models.put(MODEL_PATH, model);
      }
    } catch { /* The speech loader can fetch the archive again if storage is unavailable. */ }
  }
  await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
    .map(name => caches.delete(name)));
  await self.clients.claim();
}

self.addEventListener('activate', (event) => {
  event.waitUntil(activate());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== self.location.origin) return;
  // The voice worker streams, reports progress and caches this archive once.
  if (requestUrl.pathname.endsWith('/vendor/vosk-model-small-ru-0.22.tar.gz')) return;

  event.respondWith((async () => {
    let cached;
    try {
      cached = await caches.match(request, { cacheName: CACHE_NAME, ignoreSearch: true });
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
        const shell = await caches.match('./index.html', { cacheName: CACHE_NAME });
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
