import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

import { createStaticServer } from '../scripts/serve.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');

test('manifest describes an installable orientation-neutral app', async () => {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, 'manifest.webmanifest'), 'utf8'));

  assert.equal(manifest.name, 'Личный телесуфлёр');
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.orientation, 'any');
  assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192'));
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512' && icon.purpose.includes('maskable')));
});

for (const [filename, expectedSize] of [
  ['icon-180.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['icon-maskable-512.png', 512],
]) {
  test(`${filename} is a real square PNG at the declared size`, async () => {
    const image = await readFile(path.join(projectRoot, 'icons', filename));
    assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(image.readUInt32BE(16), expectedSize);
    assert.equal(image.readUInt32BE(20), expectedSize);
  });
}

test('every runtime shell asset is served successfully', async () => {
  const assets = [
    './',
    './index.html',
    './styles.css',
    './manifest.webmanifest',
    './sw.js',
    './js/app.js',
    './js/studio.js',
    './js/take-library.js',
    './js/capture-session.js',
    './js/camera-framing.js',
    './js/camera-lenses.js',
    './js/speech-input.js',
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
  const server = createStaticServer({ root: projectRoot });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    for (const asset of assets) {
      const response = await fetch(new URL(asset, `http://127.0.0.1:${port}/`));
      assert.equal(response.status, 200, `${asset} returned ${response.status}`);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('service worker install precaches the complete runtime shell', async () => {
  const source = await readFile(path.join(projectRoot, 'sw.js'), 'utf8');
  const listeners = new Map();
  let cachedAssets = [];
  const context = {
    URL,
    Request,
    Promise,
    self: {
      location: { href: 'https://example.test/prompt/sw.js', origin: 'https://example.test' },
      addEventListener: (type, listener) => listeners.set(type, listener),
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    },
    caches: {
      open: async () => ({ addAll: async (requests) => {
        cachedAssets = requests.map(request => {
          assert.equal(request.cache, 'reload');
          assert.ok(request.url.startsWith('https://example.test/prompt/'));
          return './' + request.url.slice('https://example.test/prompt/'.length);
        });
      } }),
      keys: async () => [],
      delete: async () => true,
      match: async () => undefined,
    },
    fetch: async () => ({ ok: true }),
  };
  vm.runInNewContext(source, context, { filename: 'sw.js' });

  let installWork;
  listeners.get('install')({ waitUntil: (promise) => { installWork = promise; } });
  await installWork;

  assert.ok(cachedAssets.includes('./index.html'));
  assert.ok(cachedAssets.includes('./js/app.js'));
  assert.ok(cachedAssets.includes('./icons/icon-512.png'));
  const checked = new Set();
  async function checkImports(asset) {
    if (checked.has(asset)) return;
    checked.add(asset);
    assert.ok(cachedAssets.includes(asset), 'Missing offline module ' + asset);
    const module = await readFile(path.join(projectRoot, asset), 'utf8');
    for (const [, relative] of module.matchAll(/from\s+['"](\.\/[^'"]+\.js)['"]/g)) {
      await checkImports('./' + path.posix.join(path.posix.dirname(asset), relative));
    }
  }
  await checkImports('./js/app.js');
  assert.ok(cachedAssets.includes('./js/speech-processor.js'));
  assert.ok(cachedAssets.includes('./js/speech-model-cache.js'));
  assert.ok(!cachedAssets.some(asset => asset.includes('vendor/')), 'the optional model must not delay installation');
});

test('the speech worker receives the model stream without a second service-worker cache write', async () => {
  const listeners = new Map();
  vm.runInNewContext(await readFile(path.join(projectRoot, 'sw.js'), 'utf8'), {
    URL, self: { location: { origin: 'https://example.test' }, addEventListener: (name, fn) => listeners.set(name, fn) },
  });
  listeners.get('fetch')({
    request: { method: 'GET', url: 'https://example.test/prompt/vendor/vosk-model-small-ru-0.22.tar.gz' },
    respondWith() { assert.fail('model request was intercepted before reaching the loader'); },
  });
});

test('service worker activation deletes only older teleprompter caches', async () => {
  const source = await readFile(path.join(projectRoot, 'sw.js'), 'utf8');
  const listeners = new Map();
  const deleted = [];
  const context = {
    URL,
    Promise,
    self: {
      location: { origin: 'https://example.test' },
      addEventListener: (type, listener) => listeners.set(type, listener),
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    },
    caches: {
      open: async () => ({ addAll: async () => {} }),
      keys: async () => [
        'teleprompter-shell-v0',
        'teleprompter-shell-v1',
        'teleprompter-shell-v2',
        'teleprompter-shell-v3',
        'teleprompter-shell-v4',
        'teleprompter-shell-v5',
        'teleprompter-shell-v6',
        'teleprompter-shell-v7',
        'teleprompter-shell-v8',
        'teleprompter-voice-models',
        'another-app-cache',
      ],
      delete: async (name) => { deleted.push(name); return true; },
      match: async () => undefined,
    },
    fetch: async () => ({ ok: true }),
  };
  vm.runInNewContext(source, context, { filename: 'sw.js' });

  let activationWork;
  listeners.get('activate')({ waitUntil: (promise) => { activationWork = promise; } });
  await activationWork;

  assert.deepEqual(deleted, [
    'teleprompter-shell-v0',
    'teleprompter-shell-v1',
    'teleprompter-shell-v2',
    'teleprompter-shell-v3',
    'teleprompter-shell-v4',
    'teleprompter-shell-v5',
    'teleprompter-shell-v6',
    'teleprompter-shell-v7',
  ]);
});

test('service worker returns a successful network response when cache writing fails', async () => {
  const source = await readFile(path.join(projectRoot, 'sw.js'), 'utf8');
  const listeners = new Map();
  const networkResponse = {
    ok: true,
    type: 'basic',
    clone() { return this; },
  };
  const errorResponse = { ok: false, type: 'error' };
  const context = {
    URL,
    Promise,
    Response: { error: () => errorResponse },
    self: {
      location: { origin: 'https://example.test' },
      addEventListener: (type, listener) => listeners.set(type, listener),
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    },
    caches: {
      open: async () => ({ put: async () => { throw new Error('quota exceeded'); } }),
      keys: async () => [],
      delete: async () => true,
      match: async () => undefined,
    },
    fetch: async () => networkResponse,
  };
  vm.runInNewContext(source, context, { filename: 'sw.js' });

  let responsePromise;
  listeners.get('fetch')({
    request: {
      method: 'GET',
      mode: 'cors',
      url: 'https://example.test/styles.css',
    },
    respondWith: (promise) => { responsePromise = promise; },
  });

  assert.equal(await responsePromise, networkResponse);
});

test('service worker falls back to the network when cache reading fails', async () => {
  const source = await readFile(path.join(projectRoot, 'sw.js'), 'utf8');
  const listeners = new Map();
  const networkResponse = {
    ok: true,
    type: 'basic',
    clone() { return this; },
  };
  const context = {
    URL,
    Promise,
    Response: { error: () => ({ ok: false, type: 'error' }) },
    self: {
      location: { origin: 'https://example.test' },
      addEventListener: (type, listener) => listeners.set(type, listener),
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    },
    caches: {
      open: async () => ({ put: async () => {} }),
      keys: async () => [],
      delete: async () => true,
      match: async () => { throw new Error('cache storage unavailable'); },
    },
    fetch: async () => networkResponse,
  };
  vm.runInNewContext(source, context, { filename: 'sw.js' });

  let responsePromise;
  listeners.get('fetch')({
    request: {
      method: 'GET',
      mode: 'cors',
      url: 'https://example.test/styles.css',
    },
    respondWith: (promise) => { responsePromise = promise; },
  });

  assert.equal(await responsePromise, networkResponse);
});
