import {
  clamp,
  countWords,
  estimateDurationMs,
  formatClock,
  formatReaderTime,
  formatWordCount,
  progressToScrollTop,
  shouldIgnoreReaderShortcut,
  shouldIgnoreShortcutRepeat,
} from './teleprompter-model.js';
import {
  getSafeStorage,
  loadAppState,
  normalizeState,
  saveAppState,
} from './settings-store.js';
import { createScrollEngine } from './scroll-engine.js';
import { createStudio } from './studio.js';
import { createReaderController, readerPrimaryAction } from './reader-controller.js';
import {
  chooseServiceWorkerUpdateAction,
  createWakeLockController,
  detectStandalone,
  exitDocumentFullscreen,
  observeServiceWorkerUpdates,
  requestElementFullscreen,
  requestServiceWorkerUpdate,
  shouldShowInstallHint,
} from './platform-controls.js';

const byId = (id) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing interface element: ${id}`);
  return element;
};

const elements = {
  setupView: byId('setup-view'),
  readerView: byId('reader-view'),
  readerStage: byId('reader-stage'),
  readerScroll: byId('reader-scroll'),
  readerText: byId('reader-text'),
  scriptInput: byId('script-input'),
  wordCount: byId('word-count'),
  readingTime: byId('reading-time'),
  saveIndicator: byId('save-indicator'),
  speedInput: byId('speed-input'),
  speedOutput: byId('speed-output'),
  fontInput: byId('font-input'),
  fontOutput: byId('font-output'),
  lineHeightInput: byId('line-height-input'),
  lineHeightOutput: byId('line-height-output'),
  widthInput: byId('width-input'),
  widthOutput: byId('width-output'),
  mirrorInput: byId('mirror-input'),
  focusInput: byId('focus-input'),
  startButton: byId('start-button'),
  backButton: byId('back-button'),
  countdownOverlay: byId('countdown-overlay'),
  countdownValue: byId('countdown-value'),
  phaseLabel: byId('phase-label'),
  timeLabel: byId('time-label'),
  progressLabel: byId('progress-label'),
  progressInput: byId('progress-input'),
  playButton: byId('play-button'),
  playIcon: byId('play-icon'),
  playLabel: byId('play-label'),
  seekBackButton: byId('seek-back-button'),
  seekForwardButton: byId('seek-forward-button'),
  restartButton: byId('restart-button'),
  readerSpeedOutput: byId('reader-speed-output'),
  readerFontOutput: byId('reader-font-output'),
  readerMirrorButton: byId('reader-mirror-button'),
  readerFocusButton: byId('reader-focus-button'),
  fullscreenButton: byId('fullscreen-button'),
  connectionBadge: byId('connection-badge'),
  installHint: byId('install-hint'),
  toast: byId('toast'),
  updateNotice: byId('update-notice'),
  updateButton: byId('update-button'),
};

const PHASE_LABELS = {
  idle: 'Готов',
  countdown: 'Отсчёт',
  playing: 'Чтение',
  paused: 'Пауза',
  finished: 'Готово',
};

const readerControlPanels = [...document.querySelectorAll('[data-reader-controls]')];

const appStorage = getSafeStorage(window);
const restored = loadAppState(appStorage);
let appState = restored.state;
let durationMs = estimateDurationMs(countWords(appState.script), appState.settings.wpm);
let currentProgress = 0;
let applyingScroll = false;
let scrollWriteToken = 0;
let saveTimer = null;
let controlsTimer = null;
let toastTimer = null;
let pendingRegistration = null;
let serviceWorkerRegistration = null;
let updateReloadRequested = false;
let updateActivatedElsewhere = false;

const wakeLock = createWakeLockController({
  navigatorRef: navigator,
  documentRef: document,
});

let readerController;
let studio;
// An untouched camera preview is a rehearsal. Each take can then begin at line one.
// Once the reader positions or pauses the text, recording leaves that choice alone.
let automaticCameraPreview = false;

const scrollEngine = createScrollEngine({
  requestFrame: window.requestAnimationFrame.bind(window),
  cancelFrame: window.cancelAnimationFrame.bind(window),
  now: () => performance.now(),
  onProgress: renderProgress,
  onFinish: () => readerController.finish(),
});

readerController = createReaderController({
  schedule: window.setTimeout.bind(window),
  cancelSchedule: window.clearTimeout.bind(window),
  onState: renderReaderState,
});

function updateWake() {
  const phase = readerController.getState().phase;
  void wakeLock.setReadingActive(Boolean(studio?.busy() || studio?.following() || ['playing', 'countdown'].includes(phase)));
}
studio = createStudio({
  view: elements.readerView, viewport: elements.readerScroll, article: elements.readerText,
  frameRate: appState.settings.frameRate,
  saveFrameRate: value => setSetting('frameRate', value),
  pauseReading: () => readerController.pause(),
  onVoiceStart: () => { automaticCameraPreview = false; },
  resumeTempo: () => readerController.start(0),
  onRecordingChange(running) {
    if (!running) { readerController.pause(); return; }
    if (!automaticCameraPreview) return;
    scrollEngine.restart();
    readerController.reset();
    readerController.start(appState.settings.countdown);
  },
  seek: progress => scrollEngine.seek(progress),
  finishReading: () => readerController.finish(), updateWake, notify: showToast, reveal: () => showControls(),
});

function showToast(message, { error = false, timeout = 3_200 } = {}) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle('is-error', error);
  elements.toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, timeout);
}

function updateConnectionBadge() {
  const offline = !navigator.onLine;
  elements.connectionBadge.classList.toggle('is-offline', offline);
  elements.connectionBadge.lastElementChild.textContent = offline ? 'Офлайн' : 'Локально';
}

function applyTheme() {
  document.body.dataset.theme = appState.settings.theme;
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  themeMeta?.setAttribute('content', appState.settings.theme === 'light' ? '#ece8df' : '#0b0d12');
}

function applyReaderAppearance() {
  const { fontSize, lineHeight, columnWidth, mirror, focusMode } = appState.settings;
  document.documentElement.style.setProperty('--reader-font-size', `${fontSize}px`);
  document.documentElement.style.setProperty('--reader-line-height', String(lineHeight));
  document.documentElement.style.setProperty('--reader-width', `${columnWidth}%`);
  elements.readerView.classList.toggle('is-mirrored', mirror);
  elements.readerView.classList.toggle('focus-off', !focusMode);
  elements.readerMirrorButton.setAttribute('aria-pressed', String(mirror));
  elements.readerFocusButton.setAttribute('aria-pressed', String(focusMode));
  studio.render();
  updateCameraTempoButton();
}

function syncControlsFromState() {
  const settings = appState.settings;
  elements.scriptInput.value = appState.script;
  elements.speedInput.value = String(settings.wpm);
  elements.fontInput.value = String(settings.fontSize);
  elements.lineHeightInput.value = String(settings.lineHeight);
  elements.widthInput.value = String(settings.columnWidth);
  elements.mirrorInput.checked = settings.mirror;
  elements.focusInput.checked = settings.focusMode;

  document.querySelectorAll('input[name="countdown"]').forEach((input) => {
    input.checked = Number(input.value) === settings.countdown;
  });
  document.querySelectorAll('input[name="theme"]').forEach((input) => {
    input.checked = input.value === settings.theme;
  });

  elements.speedOutput.textContent = `${settings.wpm} WPM`;
  elements.fontOutput.textContent = `${settings.fontSize} px`;
  elements.lineHeightOutput.textContent = settings.lineHeight.toFixed(2);
  elements.widthOutput.textContent = `${settings.columnWidth}%`;
  elements.readerSpeedOutput.textContent = String(settings.wpm);
  elements.readerFontOutput.textContent = String(settings.fontSize);
  applyTheme();
  applyReaderAppearance();
}

function recalculateDuration() {
  const words = countWords(appState.script);
  durationMs = estimateDurationMs(words, appState.settings.wpm);
  scrollEngine.setDuration(durationMs);
  elements.wordCount.textContent = formatWordCount(words);
  elements.readingTime.textContent = formatClock(durationMs);
  renderProgress(currentProgress);
}

function persistNow() {
  window.clearTimeout(saveTimer);
  saveTimer = null;
  const saved = saveAppState(appStorage, appState);
  elements.saveIndicator.textContent = saved
    ? 'Сохранено на устройстве'
    : 'Браузер не дал сохранить изменения';
  if (!saved) showToast('Не удалось сохранить сценарий в браузере.', { error: true });
}

function queueSave() {
  window.clearTimeout(saveTimer);
  elements.saveIndicator.textContent = 'Сохранение…';
  saveTimer = window.setTimeout(persistNow, 250);
}

function replaceState(candidate, { save = true } = {}) {
  appState = normalizeState(candidate);
  syncControlsFromState();
  recalculateDuration();
  if (save) queueSave();
}

function setSetting(name, value) {
  replaceState({
    ...appState,
    settings: {
      ...appState.settings,
      [name]: value,
    },
  });
}

function adjustSetting(name, delta) {
  setSetting(name, Number(appState.settings[name]) + delta);
}

function renderProgress(progress) {
  currentProgress = clamp(progress, 0, 1);
  const scrollTop = progressToScrollTop(
    currentProgress,
    elements.readerScroll.scrollHeight,
    elements.readerScroll.clientHeight,
  );

  applyingScroll = true;
  scrollWriteToken += 1;
  const token = scrollWriteToken;
  elements.readerScroll.scrollTop = scrollTop;
  window.requestAnimationFrame(() => {
    if (token === scrollWriteToken) applyingScroll = false;
  });

  elements.progressInput.value = String(Math.round(currentProgress * 1_000));
  elements.progressLabel.textContent = `${Math.round(currentProgress * 100)}%`;
  const readerTime = formatReaderTime(currentProgress, durationMs);
  elements.timeLabel.textContent = readerTime.compact;
  elements.timeLabel.setAttribute('aria-label', readerTime.accessible);
}

function showControls({ autoHide = true } = {}) {
  window.clearTimeout(controlsTimer);
  elements.readerView.classList.remove('controls-hidden');
  studio?.setControlsHidden(false);
  readerControlPanels.forEach((panel) => {
    panel.inert = false;
    panel.removeAttribute('aria-hidden');
  });
  if (autoHide && presenting() && !elements.readerView.classList.contains('has-camera')) {
    controlsTimer = window.setTimeout(hideControls, 2_800);
  }
}

function presenting() {
  return readerController.getState().phase === 'playing' || studio?.following() || studio?.busy();
}

function hideControls() {
  window.clearTimeout(controlsTimer);
  if (!presenting() || elements.readerView.classList.contains('has-camera')) return;
  elements.readerView.classList.add('controls-hidden');
  studio?.setControlsHidden(true);
  readerControlPanels.forEach((panel) => {
    panel.inert = true;
    panel.setAttribute('aria-hidden', 'true');
  });
}

function renderReaderState(state) {
  elements.readerView.dataset.phase = state.phase;
  updateCameraTempoButton();
  elements.phaseLabel.textContent = PHASE_LABELS[state.phase] ?? 'Готов';
  elements.countdownOverlay.hidden = state.phase !== 'countdown';
  if (state.phase === 'countdown') {
    elements.countdownValue.textContent = String(state.countdownRemaining);
  }

  const moving = state.phase === 'playing';
  const primaryAction = readerPrimaryAction(state.phase);
  elements.playButton.setAttribute('aria-pressed', String(primaryAction.pressed));
  elements.playButton.setAttribute('aria-label', primaryAction.label);
  elements.playIcon.textContent = ['playing', 'countdown'].includes(state.phase) ? 'Ⅱ' : '▶';
  elements.playLabel.textContent = primaryAction.label;

  if (moving) {
    scrollEngine.play(durationMs);
    showControls();
  } else {
    scrollEngine.pause();
    showControls({ autoHide: false });
  }
  updateWake();

  if (state.phase === 'finished') {
    showToast('Сценарий прочитан. Можно начать сначала.');
  }
}

function updateCameraTempoButton() {
  const button = byId('camera-auto-toggle');
  const phase = readerController.getState().phase;
  const active = phase === 'playing' || phase === 'countdown';
  button.disabled = !elements.readerText.textContent.trim();
  button.setAttribute('aria-pressed', String(active));
  button.title = active ? 'Поставить автопрокрутку на паузу' : 'Прокрутка по темпу';
  button.setAttribute('aria-label', button.title + ' · ' + appState.settings.wpm + ' слов/мин');
}

function enterReader(withCamera = false) {
  const script = elements.scriptInput.value;
  if (!withCamera && !script.trim()) {
    showToast('Сначала вставьте текст сценария.', { error: true });
    elements.scriptInput.focus();
    return;
  }

  replaceState({ ...appState, script }, { save: false });
  persistNow();
  elements.readerText.textContent = appState.script;
  automaticCameraPreview = false;
  studio.render();
  elements.setupView.hidden = true;
  elements.readerView.hidden = false;
  scrollEngine.pause();
  scrollEngine.restart();
  readerController.reset();
  renderProgress(0);

  if (withCamera) {
    void studio.toggleCamera().then(opened => {
      if (opened && script.trim() && !elements.readerView.hidden && !studio.following()
          && readerController.getState().phase === 'idle') {
        automaticCameraPreview = true;
        readerController.start(appState.settings.countdown);
      }
    });
  } else {
    requestElementFullscreen(document.documentElement).then(result => {
      elements.installHint.hidden = !shouldShowInstallHint(result, isStandalone());
    });
    readerController.start(appState.settings.countdown);
  }
  elements.readerScroll.focus({ preventScroll: true });
}

async function leaveReader() {
  if (!await studio.leave()) return;
  readerController.pause();
  void wakeLock.setReadingActive(false);
  elements.readerView.hidden = true;
  elements.setupView.hidden = false;
  showControls({ autoHide: false });
  const fullscreenElement = document.fullscreenElement ?? document.webkitFullscreenElement;
  if (fullscreenElement) void exitDocumentFullscreen(document);
  elements.scriptInput.focus({ preventScroll: true });
}

function togglePlayback() {
  automaticCameraPreview = false;
  if (!elements.readerText.textContent.trim()) return;
  if (studio.following()) studio.stopVoice();
  const phase = readerController.getState().phase;
  if (phase === 'finished') {
    scrollEngine.restart();
    readerController.reset();
    readerController.start(0);
  } else {
    readerController.toggle();
  }
  showControls();
}

function restartReading() {
  automaticCameraPreview = false;
  if (!elements.readerText.textContent.trim()) return;
  if (studio.following()) studio.stopVoice();
  scrollEngine.restart();
  readerController.reset();
  readerController.start(0);
  showControls();
}

function reconcileSeekState(progress) {
  readerController.reconcileProgress(progress);
}

function seekBy(milliseconds) {
  automaticCameraPreview = false;
  if (durationMs <= 0) return;
  const next = scrollEngine.seek(currentProgress + (milliseconds / durationMs));
  reconcileSeekState(next);
  studio.userMoved();
  showControls();
}

function isStandalone() {
  return detectStandalone({
    navigatorRef: navigator,
    matchMediaFn: window.matchMedia.bind(window),
  });
}

async function toggleFullscreen() {
  const fullscreenElement = document.fullscreenElement ?? document.webkitFullscreenElement;
  if (fullscreenElement) {
    await exitDocumentFullscreen(document);
    return;
  }

  const result = await requestElementFullscreen(document.documentElement);
  const standalone = isStandalone();
  if (shouldShowInstallHint(result, standalone)) {
    elements.installHint.hidden = false;
    showToast('Полный экран недоступен. Установите приложение на главный экран.');
  } else if (result !== 'entered' && standalone) {
    elements.installHint.hidden = true;
    showToast('Приложение уже открыто без панели браузера.');
  }
}

function handleKeyboard(event) {
  if (elements.readerView.hidden || studio.library.isOpen()) return;
  if (shouldIgnoreReaderShortcut(document.activeElement, event.code)) return;
  if (shouldIgnoreShortcutRepeat(event.code, event.repeat)) {
    event.preventDefault();
    return;
  }

  const actions = {
    Space: togglePlayback,
    ArrowUp: () => adjustSetting('wpm', 5),
    ArrowDown: () => adjustSetting('wpm', -5),
    ArrowLeft: () => seekBy(-5_000),
    ArrowRight: () => seekBy(5_000),
    KeyR: restartReading,
    KeyF: () => { void toggleFullscreen(); },
    KeyM: toggleMirror,
  };

  const action = actions[event.code];
  if (!action) return;
  event.preventDefault();
  action();
  showControls();
}

function handleManualScroll() {
  if (scrollEngine.getSnapshot().isPlaying) return;
  const distance = Math.max(0, elements.readerScroll.scrollHeight - elements.readerScroll.clientHeight);
  if (distance === 0) return;
  // Scroll events from programmatic writes can arrive after the next frame.
  if (Math.abs(currentProgress * distance - elements.readerScroll.scrollTop) < 1) return;
  if (applyingScroll && !studio.following()) return;
  automaticCameraPreview = false;
  const next = scrollEngine.seek(elements.readerScroll.scrollTop / distance);
  reconcileSeekState(next);
  studio.userMoved();
}

function handleReaderTap(event) {
  if (event.target.closest('button, input, label, a')) return;
  if (elements.readerView.classList.contains('controls-hidden')) {
    showControls();
  } else if (presenting()) {
    hideControls();
  }
}

function bindRange(input, settingName) {
  input.addEventListener('input', () => setSetting(settingName, Number(input.value)));
}

elements.scriptInput.addEventListener('input', () => {
  appState = normalizeState({ ...appState, script: elements.scriptInput.value });
  recalculateDuration();
  queueSave();
});

bindRange(elements.speedInput, 'wpm');
bindRange(elements.fontInput, 'fontSize');
bindRange(elements.lineHeightInput, 'lineHeight');
bindRange(elements.widthInput, 'columnWidth');

document.querySelectorAll('input[name="countdown"]').forEach((input) => {
  input.addEventListener('change', () => {
    if (input.checked) setSetting('countdown', Number(input.value));
  });
});

document.querySelectorAll('input[name="theme"]').forEach((input) => {
  input.addEventListener('change', () => {
    if (input.checked) setSetting('theme', input.value);
  });
});

elements.mirrorInput.addEventListener('change', () => setSetting('mirror', elements.mirrorInput.checked));
elements.focusInput.addEventListener('change', () => setSetting('focusMode', elements.focusInput.checked));
elements.startButton.addEventListener('click', () => enterReader());
byId('shoot-button').addEventListener('click', () => enterReader(true));
elements.backButton.addEventListener('click', leaveReader);
elements.playButton.addEventListener('click', togglePlayback);
byId('camera-auto-toggle').addEventListener('click', togglePlayback);
elements.restartButton.addEventListener('click', restartReading);
elements.seekBackButton.addEventListener('click', () => seekBy(-5_000));
elements.seekForwardButton.addEventListener('click', () => seekBy(5_000));
elements.fullscreenButton.addEventListener('click', () => { void toggleFullscreen(); });
function toggleMirror() {
  if (!studio.mirrorPreview()) setSetting('mirror', !appState.settings.mirror);
}
elements.readerMirrorButton.addEventListener('click', toggleMirror);
elements.readerFocusButton.addEventListener('click', () => setSetting('focusMode', !appState.settings.focusMode));
elements.readerStage.addEventListener('click', handleReaderTap);
elements.readerStage.addEventListener('pointermove', () => showControls());
elements.readerScroll.addEventListener('scroll', handleManualScroll, { passive: true });

elements.progressInput.addEventListener('input', () => {
  automaticCameraPreview = false;
  const next = scrollEngine.seek(Number(elements.progressInput.value) / 1_000);
  reconcileSeekState(next);
  studio.userMoved();
  showControls();
});

document.querySelector('[data-action="speed-down"]').addEventListener('click', () => adjustSetting('wpm', -5));
document.querySelector('[data-action="speed-up"]').addEventListener('click', () => adjustSetting('wpm', 5));
document.querySelector('[data-action="reader-speed-down"]').addEventListener('click', () => adjustSetting('wpm', -5));
document.querySelector('[data-action="reader-speed-up"]').addEventListener('click', () => adjustSetting('wpm', 5));
document.querySelector('[data-action="reader-font-down"]').addEventListener('click', () => adjustSetting('fontSize', -2));
document.querySelector('[data-action="reader-font-up"]').addEventListener('click', () => adjustSetting('fontSize', 2));

document.addEventListener('keydown', handleKeyboard);
window.addEventListener('online', () => {
  updateConnectionBadge();
  void requestServiceWorkerUpdate(serviceWorkerRegistration);
});
window.addEventListener('offline', updateConnectionBadge);
window.addEventListener('beforeunload', persistNow);
window.addEventListener('pagehide', persistNow);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) persistNow();
  if (document.hidden && ['playing', 'countdown'].includes(readerController.getState().phase)) {
    readerController.pause();
    showToast('Чтение поставлено на паузу после сворачивания.');
  }
  if (!document.hidden) void requestServiceWorkerUpdate(serviceWorkerRegistration);
  void wakeLock.handleVisibilityChange();
});

let resizeFrame = null;
function handleViewportChange() {
  window.cancelAnimationFrame(resizeFrame);
  resizeFrame = window.requestAnimationFrame(() => {
    renderProgress(currentProgress);
    studio.refresh();
  });
}

window.addEventListener('resize', handleViewportChange);
window.visualViewport?.addEventListener('resize', handleViewportChange);

function handleFullscreenChange() {
  const active = Boolean(document.fullscreenElement ?? document.webkitFullscreenElement);
  elements.fullscreenButton.setAttribute('aria-label', active ? 'Выйти из полного экрана' : 'Полный экран');
}

document.addEventListener('fullscreenchange', handleFullscreenChange);
document.addEventListener('webkitfullscreenchange', handleFullscreenChange);

elements.updateButton.addEventListener('click', () => {
  if (studio.busy() || studio.library.hasUnsaved()) {
    showToast('Завершите запись и сохраните дубль перед обновлением.');
    return;
  }
  const action = chooseServiceWorkerUpdateAction({
    activatedElsewhere: updateActivatedElsewhere,
    waiting: pendingRegistration?.waiting,
  });
  if (action === 'reload') {
    window.location.reload();
    return;
  }

  updateReloadRequested = true;
  pendingRegistration?.waiting?.postMessage({ type: 'SKIP_WAITING' });
});

function offerServiceWorkerUpdate(registration) {
  pendingRegistration = registration;
  updateActivatedElsewhere = false;
  elements.updateButton.textContent = 'Обновить';
  elements.updateNotice.hidden = false;
}

window.teleprompterSWReady?.then((registration) => {
  if (!registration) return;
  serviceWorkerRegistration = registration;
  observeServiceWorkerUpdates(registration, {
    onUpdateReady: offerServiceWorkerUpdate,
  });
});

navigator.serviceWorker?.addEventListener('message', (event) => {
  if (event.data?.type === 'UPDATE_READY' && pendingRegistration) {
    offerServiceWorkerUpdate(pendingRegistration);
  }
});

navigator.serviceWorker?.addEventListener('controllerchange', () => {
  if (updateReloadRequested) {
    updateReloadRequested = false;
    window.location.reload();
    return;
  }

  if (!elements.updateNotice.hidden) {
    updateActivatedElsewhere = true;
    elements.updateButton.textContent = 'Перезагрузить';
  }
});

syncControlsFromState();
recalculateDuration();
renderProgress(0);
updateConnectionBadge();

const appleTouchDevice = /iPhone|iPad|iPod/u.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
elements.installHint.hidden = !(appleTouchDevice && !isStandalone());

if (restored.recovered) {
  showToast('Повреждённые локальные настройки сброшены. Текст можно вставить заново.', { error: true });
}
