const CACHE_PREFIX = 'teleprompter-shell-';
const CACHE_NAME = `${CACHE_PREFIX}v10`;
const MODEL_PATH = './vendor/vosk-model-small-ru-0.22.tar.gz';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './fonts/manrope-variable.woff2',
  './icons/icon-source.svg',
  './icons/script-cat.svg',
  './manifest.webmanifest',
  './js/app.js',
  './js/studio.js',
  './js/take-library.js',
  './js/take-frame-rate.js',
  './js/capture-session.js',
  './js/camera-framing.js',
  './js/camera-lenses.js',
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
    // Always install the new revision, even when the previous shell is in HTTP cache.
    caches.open(CACHE_NAME).then((cache) => cache.addAll(
      APP_SHELL.map(path => new Request(new URL(path, self.location.href), { cache: 'reload' })),
    )),
  );
});

async function activate() {
  const names = await caches.keys();
  const previousShell = ['teleprompter-shell-v9', 'teleprompter-shell-v8', 'teleprompter-shell-v7', 'teleprompter-shell-v6', 'teleprompter-shell-v5'].find(name => names.includes(name));
  if (previousShell) {
    // These releases share the same pinned voice engine. Keep it available offline.
    for (const asset of ['./vendor/vosk-0.0.8-mobile.js', './vendor/vosk-worker-0.0.8-mobile.js']) {
      try {
        const cached = await caches.match(asset, { cacheName: previousShell, ignoreSearch: true });
        if (cached) await (await caches.open(CACHE_NAME)).put(asset, cached);
      } catch { /* Optional assets can be downloaded again online. */ }
    }
  }
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
