import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chooseServiceWorkerUpdateAction,
  createWakeLockController,
  detectStandalone,
  observeServiceWorkerUpdates,
  requestServiceWorkerUpdate,
  requestElementFullscreen,
  shouldShowInstallHint,
} from '../js/platform-controls.js';

test('detectStandalone accepts the iOS navigator flag', () => {
  assert.equal(detectStandalone({
    navigatorRef: { standalone: true },
    matchMediaFn: () => ({ matches: false }),
  }), true);
});

test('detectStandalone accepts standalone display mode', () => {
  assert.equal(detectStandalone({
    navigatorRef: {},
    matchMediaFn: () => ({ matches: true }),
  }), true);
});

test('requestElementFullscreen reports a successful request', async () => {
  let calls = 0;
  const result = await requestElementFullscreen({
    async requestFullscreen() { calls += 1; },
  });

  assert.equal(result, 'entered');
  assert.equal(calls, 1);
});

test('requestElementFullscreen reports a rejected request', async () => {
  const result = await requestElementFullscreen({
    async requestFullscreen() { throw new Error('denied'); },
  });

  assert.equal(result, 'denied');
});

test('requestElementFullscreen reports an unsupported request', async () => {
  assert.equal(await requestElementFullscreen({}), 'unsupported');
});

test('install hint is offered only when fullscreen failed outside standalone mode', () => {
  assert.equal(shouldShowInstallHint('unsupported', false), true);
  assert.equal(shouldShowInstallHint('denied', false), true);
  assert.equal(shouldShowInstallHint('unsupported', true), false);
  assert.equal(shouldShowInstallHint('entered', false), false);
});

test('service worker observer attaches to an update already installing', () => {
  const workerListeners = new Map();
  const worker = {
    state: 'installing',
    addEventListener: (type, listener) => workerListeners.set(type, listener),
  };
  const registration = {
    waiting: null,
    installing: worker,
    active: {},
    addEventListener() {},
  };
  let offers = 0;

  observeServiceWorkerUpdates(registration, {
    onUpdateReady: () => { offers += 1; },
  });
  worker.state = 'installed';
  workerListeners.get('statechange')();

  assert.equal(offers, 1);
});

test('service worker observer reacts to a future updatefound event', () => {
  const registrationListeners = new Map();
  const workerListeners = new Map();
  const registration = {
    waiting: null,
    installing: null,
    active: {},
    addEventListener: (type, listener) => registrationListeners.set(type, listener),
  };
  let offers = 0;

  observeServiceWorkerUpdates(registration, {
    onUpdateReady: () => { offers += 1; },
  });
  registration.installing = {
    state: 'installing',
    addEventListener: (type, listener) => workerListeners.set(type, listener),
  };
  registrationListeners.get('updatefound')();
  registration.installing.state = 'installed';
  workerListeners.get('statechange')();

  assert.equal(offers, 1);
});

test('service worker observer does not call a first install an update', () => {
  const workerListeners = new Map();
  const worker = {
    state: 'installing',
    addEventListener: (type, listener) => workerListeners.set(type, listener),
  };
  const registration = {
    waiting: null,
    installing: worker,
    active: null,
    addEventListener() {},
  };
  let offers = 0;

  observeServiceWorkerUpdates(registration, {
    onUpdateReady: () => { offers += 1; },
  });
  worker.state = 'installed';
  workerListeners.get('statechange')();

  assert.equal(offers, 0);
});

test('service worker update checks are best-effort', async () => {
  assert.equal(await requestServiceWorkerUpdate(null), 'unsupported');
  assert.equal(await requestServiceWorkerUpdate({ update: async () => {} }), 'checked');
  assert.equal(await requestServiceWorkerUpdate({
    update: async () => { throw new Error('offline'); },
  }), 'failed');
});

test('service worker update button reloads after another tab activated the worker', () => {
  assert.equal(chooseServiceWorkerUpdateAction({ activatedElsewhere: false, waiting: {} }), 'activate');
  assert.equal(chooseServiceWorkerUpdateAction({ activatedElsewhere: true, waiting: null }), 'reload');
  assert.equal(chooseServiceWorkerUpdateAction({ activatedElsewhere: false, waiting: null }), 'reload');
});

function createWakeHarness() {
  let visibilityState = 'visible';
  let requestCount = 0;
  let releaseCount = 0;
  let releaseListener = () => {};

  const sentinel = {
    released: false,
    async release() {
      this.released = true;
      releaseCount += 1;
      releaseListener();
    },
    addEventListener(type, listener) {
      if (type === 'release') releaseListener = listener;
    },
  };

  return {
    navigatorRef: {
      wakeLock: {
        async request(type) {
          assert.equal(type, 'screen');
          requestCount += 1;
          sentinel.released = false;
          return sentinel;
        },
      },
    },
    documentRef: {
      get visibilityState() { return visibilityState; },
    },
    hide() { visibilityState = 'hidden'; },
    show() { visibilityState = 'visible'; },
    requestCount: () => requestCount,
    releaseCount: () => releaseCount,
  };
}

test('wake lock is acquired only when reading becomes active', async () => {
  const harness = createWakeHarness();
  const controller = createWakeLockController(harness);

  assert.equal(harness.requestCount(), 0);
  assert.equal(await controller.setReadingActive(true), 'acquired');
  assert.equal(harness.requestCount(), 1);
});

test('pausing releases an acquired wake lock', async () => {
  const harness = createWakeHarness();
  const controller = createWakeLockController(harness);

  await controller.setReadingActive(true);
  await controller.setReadingActive(false);

  assert.equal(harness.releaseCount(), 1);
  assert.equal(controller.getState().desired, false);
});

test('visibility changes release and reacquire the desired wake lock', async () => {
  const harness = createWakeHarness();
  const controller = createWakeLockController(harness);

  await controller.setReadingActive(true);
  harness.hide();
  await controller.handleVisibilityChange();
  harness.show();
  await controller.handleVisibilityChange();

  assert.equal(harness.releaseCount(), 1);
  assert.equal(harness.requestCount(), 2);
  assert.equal(controller.getState().held, true);
});
