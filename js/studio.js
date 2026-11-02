import { createCaptureSession } from './capture-session.js';
import { createSpeechInput } from './speech-input.js';
import { createVoiceScroll } from './voice-scroll.js';
import { createTakeLibrary } from './take-library.js';
import { formatClock } from './teleprompter-model.js';

export function createStudio({ view, viewport, article, pauseReading, seek, finishReading, notify, updateWake, reveal }) {
  const id = name => document.getElementById(name);
  const camera = id('camera-toggle');
  const record = id('record-button');
  const toggle = id('voice-toggle');
  const preview = id('camera-preview');
  const message = id('studio-message');
  const mirror = id('reader-mirror-button');
  const dock = view.querySelector('.studio-dock');
  let opening = false;
  let cameraEpoch = 0;
  let voiceEpoch = 0;
  let voiceOn = false;
  let mirroredPreview = true;
  let timer = null;
  let quietTimer = null;
  let heard = '';
  let wasPresenting = false;

  const library = createTakeLibrary({ notify, onOpen: () => {
    pauseReading();
    if (voiceOn) stopVoice();
  } });
  const capture = createCaptureSession({
    onChange: render,
    onResult(blob) {
      void library.add(blob);
      notify('Дубль готов. Откройте «Дубли», чтобы посмотреть или сохранить видео.');
    },
    onError: notify,
  });
  const follower = createVoiceScroll({
    viewport, article, seek,
    onAnchor: () => {
      try { speech.resetSegment(); }
      catch { voiceFailed(new Error('Не удалось продолжить распознавание после прокрутки.')); }
    },
    onFinish: () => {
      stopVoice();
      finishReading();
      message.textContent = 'Сценарий прочитан.';
    },
  });
  const speech = createSpeechInput({
    onStatus(state) {
      if (state === 'loading') message.textContent = 'Загружается русская модель. Первый запуск — около 52 МБ.';
      if (state === 'listening') message.textContent = 'Слушаю. Начните читать текст.';
    },
    onResult({ text, final, segment }) {
      if (!voiceOn) return;
      const result = follower.accept(text, final);
      if (!result || !voiceOn) return;
      const signature = segment + ' ' + text;
      if (!final && signature === heard) return;
      heard = signature;
      message.textContent = result.matched ? 'Слушаю' : 'Не удалось сопоставить речь. Прочитайте несколько слов со строки.';
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => { if (voiceOn) message.textContent = 'Пауза. Продолжайте с текущей строки.'; }, 1600);
    },
    onError: voiceFailed,
  });

  function updateClock() {
    id('record-clock').textContent = formatClock(capture.getState().elapsedMs);
  }
  function render(state = capture.getState()) {
    const active = state.recording !== 'idle';
    const running = state.recording === 'recording';
    const cameraChanged = view.classList.contains('has-camera') !== state.camera;
    view.classList.toggle('has-camera', state.camera);
    preview.hidden = !state.camera;
    const stream = state.camera ? state.stream : null;
    if (preview.srcObject !== stream) {
      preview.srcObject = stream;
      if (stream) preview.play().catch(() => {
        if (preview.srcObject === stream) notify('Не удалось показать превью. Выключите и снова включите камеру.');
      });
    }
    preview.classList.toggle('selfie', mirroredPreview);
    mirror.textContent = state.camera ? 'Зеркало превью' : 'Зеркало';
    mirror.setAttribute('aria-pressed', String(state.camera ? mirroredPreview : view.classList.contains('is-mirrored')));
    camera.setAttribute('aria-pressed', String(state.camera));
    camera.disabled = active;
    camera.textContent = opening ? 'Отменить запрос' : state.camera ? 'Выкл. камеру' : 'Камера';
    record.hidden = !state.camera && !active;
    record.disabled = state.recording === 'stopping';
    record.textContent = ({ starting: 'Отменить старт', recording: 'Остановить запись',
      stopping: 'Завершаю…', idle: 'Начать запись' })[state.recording];
    id('record-indicator').hidden = !running;
    id('track-warning').textContent = (state.camera || active || voiceOn) && state.audioMuted
      ? 'Микрофон временно не передаёт звук.'
      : state.camera && state.videoMuted ? 'Камера временно не передаёт изображение.' : '';
    id('reader-takes').disabled = active;
    toggle.setAttribute('aria-checked', String(voiceOn));
    if (running && timer === null) {
      updateClock();
      timer = setInterval(updateClock, 250);
    } else if (!running && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (cameraChanged) follower.refresh();
    if (wasPresenting !== (voiceOn || active)) {
      wasPresenting = voiceOn || active;
      reveal();
    }
    updateWake();
  }

  async function toggleCamera() {
    const token = ++cameraEpoch;
    if (opening || capture.getState().camera) {
      opening = false;
      capture.disableCamera();
      return;
    }
    opening = true;
    render();
    try { await capture.enableCamera(); }
    catch (error) { if (token === cameraEpoch) notify(error.message); }
    finally { if (token === cameraEpoch) { opening = false; render(); } }
  }

  function stopVoice() {
    ++voiceEpoch;
    voiceOn = false;
    heard = '';
    clearTimeout(quietTimer);
    follower.stop();
    speech.stop();
    capture.releaseVoice();
    message.textContent = '';
  }
  function voiceFailed(error) {
    stopVoice();
    message.textContent = error.message + ' Доступна ручная прокрутка или кнопка «Пуск».';
  }
  async function toggleVoice() {
    if (voiceOn) { stopVoice(); return; }
    const token = ++voiceEpoch;
    voiceOn = true;
    pauseReading();
    try {
      follower.start();
      render();
      message.textContent = 'Ожидаю доступ к микрофону…';
      speech.prepare();
      const track = await capture.acquireVoice();
      if (token !== voiceEpoch) return;
      await speech.start(new MediaStream([track]));
    } catch (error) {
      if (token === voiceEpoch) voiceFailed(error);
    }
  }
  async function close() {
    ++cameraEpoch;
    opening = false;
    stopVoice();
    await capture.close();
  }
  function busy() { return capture.getState().recording !== 'idle'; }
  async function leave() {
    if (busy() && !window.confirm('Остановить запись, сохранить дубль и вернуться к тексту?')) return false;
    await close();
    return true;
  }
  camera.addEventListener('click', toggleCamera);
  record.addEventListener('click', () => {
    if (busy()) void capture.stopRecording();
    else {
      try { capture.startRecording(); }
      catch (error) { notify(error.message); }
    }
  });
  toggle.addEventListener('click', toggleVoice);
  const sizeDock = () => view.style.setProperty('--dock-height', dock.offsetHeight + 'px');
  if (globalThis.ResizeObserver) new ResizeObserver(sizeDock).observe(dock);
  else window.addEventListener('resize', sizeDock);
  window.addEventListener('beforeunload', event => {
    if (busy() || library.hasUnsaved()) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  window.addEventListener('pagehide', () => { void close(); });
  document.addEventListener('visibilitychange', () => {
    // Mobile OSes can suspend the tab immediately. Finalize while it can
    // still receive data rather than continuing a silent or frozen take.
    if (document.hidden) void close();
  });
  return {
    toggleCamera, leave, busy, render, library,
    setControlsHidden(hidden) {
      dock.inert = hidden && !capture.getState().camera && !busy() && !voiceOn;
    },
    following: () => voiceOn, stopVoice,
    userMoved: follower.userMoved, refresh: follower.refresh,
    mirrorPreview() {
      if (!capture.getState().camera) return false;
      mirroredPreview = !mirroredPreview;
      render();
      return true;
    },
  };
}
