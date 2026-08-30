export function detectStandalone({ navigatorRef, matchMediaFn }) {
  if (navigatorRef?.standalone === true) return true;

  try {
    return Boolean(matchMediaFn?.('(display-mode: standalone)')?.matches);
  } catch {
    return false;
  }
}

export async function requestElementFullscreen(element) {
  const request = element?.requestFullscreen ?? element?.webkitRequestFullscreen;
  if (typeof request !== 'function') return 'unsupported';

  try {
    await request.call(element);
    return 'entered';
  } catch {
    return 'denied';
  }
}

export async function exitDocumentFullscreen(documentRef) {
  const exit = documentRef?.exitFullscreen ?? documentRef?.webkitExitFullscreen;
  if (typeof exit !== 'function') return 'unsupported';

  try {
    await exit.call(documentRef);
    return 'exited';
  } catch {
    return 'denied';
  }
}

export function shouldShowInstallHint(fullscreenResult, standalone) {
  return fullscreenResult !== 'entered' && !standalone;
}

export function observeServiceWorkerUpdates(registration, {
  onUpdateReady,
}) {
  const observedWorkers = new WeakSet();

  function observe(worker) {
    if (!worker || observedWorkers.has(worker)) return;
    observedWorkers.add(worker);
    const updatesExistingWorker = Boolean(registration.active);

    const handleStateChange = () => {
      if (worker.state === 'installed' && updatesExistingWorker) {
        onUpdateReady(registration);
      }
    };

    worker.addEventListener?.('statechange', handleStateChange);
    handleStateChange();
  }

  if (registration.waiting && registration.active) {
    onUpdateReady(registration);
  }
  observe(registration.installing);
  registration.addEventListener?.('updatefound', () => observe(registration.installing));
}

export async function requestServiceWorkerUpdate(registration) {
  if (typeof registration?.update !== 'function') return 'unsupported';

  try {
    await registration.update();
    return 'checked';
  } catch {
    return 'failed';
  }
}

export function chooseServiceWorkerUpdateAction({ activatedElsewhere, waiting }) {
  return activatedElsewhere || !waiting ? 'reload' : 'activate';
}

export function createWakeLockController({ navigatorRef, documentRef }) {
  let desired = false;
  let sentinel = null;
  let acquiring = null;

  async function releaseHeldLock() {
    if (!sentinel) return 'idle';

    const heldSentinel = sentinel;
    sentinel = null;
    try {
      await heldSentinel.release();
      return 'released';
    } catch {
      return 'denied';
    }
  }

  async function acquire() {
    if (!desired) return 'idle';
    if (documentRef?.visibilityState !== 'visible') return 'hidden';
    if (sentinel && !sentinel.released) return 'acquired';
    if (acquiring) return acquiring;
    if (typeof navigatorRef?.wakeLock?.request !== 'function') return 'unsupported';

    acquiring = (async () => {
      try {
        const nextSentinel = await navigatorRef.wakeLock.request('screen');
        if (!desired || documentRef?.visibilityState !== 'visible') {
          await nextSentinel.release();
          return 'idle';
        }

        sentinel = nextSentinel;
        sentinel.addEventListener?.('release', () => {
          if (sentinel === nextSentinel) sentinel = null;
        });
        return 'acquired';
      } catch {
        return 'denied';
      } finally {
        acquiring = null;
      }
    })();

    return acquiring;
  }

  async function setReadingActive(active) {
    desired = Boolean(active);
    if (!desired) return releaseHeldLock();
    return acquire();
  }

  async function handleVisibilityChange() {
    if (documentRef?.visibilityState !== 'visible') {
      return releaseHeldLock();
    }
    return acquire();
  }

  function getState() {
    return {
      desired,
      held: Boolean(sentinel && !sentinel.released),
    };
  }

  return {
    setReadingActive,
    handleVisibilityChange,
    getState,
  };
}
