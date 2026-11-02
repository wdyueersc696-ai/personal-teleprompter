import { createCaptureSession } from './capture-session.js';
import { createSpeechInput } from './speech-input.js';
import { createVoiceScroll } from './voice-scroll.js';
import { createTakeLibrary } from './take-library.js';
import { formatClock } from './teleprompter-model.js';

export function createStudio({ view, viewport, article, pauseReading, resumeTempo, onVoiceStart, onRecordingChange,
  seek, finishReading, notify, updateWake, reveal }) {
  const id = name => document.getElementById(name);
  const camera = id('camera-toggle');
  const record = id('record-button');
  const toggle = id('voice-toggle');
  const preview = id('camera-preview');
  const message = id('studio-message');
  const mirror = id('reader-mirror-button');
  const dock = view.querySelector('.studio-dock');
  const promptToggle = id('prompt-toggle');
  const optionsToggle = id('camera-options-toggle');
  const zoomControls = id('camera-zoom');
  let opening = false;
  let cameraEpoch = 0;
  let voiceEpoch = 0;
  let voiceOn = false;
  let mirroredPreview = true;
  let timer = null;
  let quietTimer = null;
  let heard = '';
  let wasPresenting = false;
  let wasRecording = false;
  let restoreTempo = false;

  const library = createTakeLibrary({ notify, onOpen: () => {
    pauseReading();
    if (voiceOn) stopVoice();
  } });
  const capture = createCaptureSession({
    previewElement: preview,
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
    onStatus(state, detail = {}) {
      toggle.dataset.state = state;
      toggle.setAttribute('aria-busy', String(!['off', 'listening', 'quiet'].includes(state)));
      if (state === 'off') return;
      let label = {
        loading: 'Загружаю распознавание…',
        initializing: 'Подготавливаю русскую модель…',
        microphone: 'Проверяю микрофон…',
        listening: 'Слушаю. Читайте сценарий.',
        quiet: 'Пока нет звука · скажите пару слов',
      }[state];
      if (state === 'downloading') {
        const mb = Math.floor(detail.loaded / 1e6);
        label = (detail.cached ? 'Открываю модель' : 'Загружаю модель') + ' · ' + mb
          + (detail.total ? ' из ' + Math.round(detail.total / 1e6) : '') + ' МБ';
      }
      if (label && message.textContent !== label) message.textContent = label;
    },
    onResult({ text, final, segment }) {
      if (!voiceOn) return;
      const result = follower.accept(text, final);
      if (!result || !voiceOn) return;
      const signature = segment + ' ' + text;
      if (!final && signature === heard) return;
      heard = signature;
      message.textContent = result.matched ? 'Слушаю' : 'Повторите несколько слов из текущей строки.';
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => { if (voiceOn) message.textContent = 'Пауза · жду речь'; }, 1600);
    },
    onError: voiceFailed,
  });

  function updateClock() {
    id('record-clock').textContent = formatClock(capture.getState().elapsedMs);
  }
  function setPromptVisible(visible) {
    view.classList.toggle('prompt-hidden', !visible);
    view.querySelector('.prompt-window').inert = !visible;
    promptToggle.setAttribute('aria-pressed', String(visible));
    promptToggle.title = visible ? 'Скрыть сценарий' : 'Показать сценарий';
  }
  function setOptionsOpen(open) {
    view.classList.toggle('camera-settings-open', open);
    optionsToggle.setAttribute('aria-expanded', String(open));
  }
  function render(state = capture.getState()) {
    const active = state.recording !== 'idle';
    const running = state.recording === 'recording';
    const cameraChanged = view.classList.contains('has-camera') !== state.camera;
    view.classList.toggle('has-camera', state.camera);
    view.classList.toggle('no-script', !article.textContent.trim());
    preview.hidden = !state.camera;
    const stream = state.camera ? state.stream : null;
    if (preview.srcObject !== stream) {
      preview.srcObject = stream;
      if (stream) preview.play().catch(() => {
        if (preview.srcObject === stream) notify('Не удалось показать превью. Выключите и снова включите камеру.');
      });
    }
    preview.classList.toggle('selfie', mirroredPreview);
    if (state.camera) {
      const input = preview.videoWidth ? ' · Вход камеры ' + preview.videoWidth + '×' + preview.videoHeight : '';
      const framing = state.zoom !== 0.5 ? '' : state.zoomMode === 'device'
        ? ' · 0,5× средствами камеры' : ' · 0,5× с программным масштабированием';
      id('capture-info').textContent = 'Файл 720×1280 · до 30 кадр/с' + input + framing;
    }
    mirror.textContent = state.camera ? 'Зеркало превью' : 'Зеркало';
    mirror.setAttribute('aria-pressed', String(state.camera ? mirroredPreview : view.classList.contains('is-mirrored')));
    camera.setAttribute('aria-pressed', String(state.camera));
    camera.disabled = active;
    id('camera-off').disabled = active;
    camera.textContent = opening ? 'Отменить запрос' : state.camera ? 'Выкл. камеру' : 'Камера';
    record.hidden = !state.camera && !active;
    record.disabled = state.recording === 'stopping' || (!active && preview.readyState < 2);
    record.textContent = ({ starting: 'Отменить старт', recording: 'Остановить запись',
      stopping: 'Завершаю…', idle: 'Начать запись' })[state.recording];
    record.setAttribute('aria-pressed', String(running));
    record.setAttribute('aria-label', record.textContent);
    record.title = record.textContent;
    id('record-indicator').hidden = !running;
    id('track-warning').textContent = (state.camera || active || voiceOn) && state.audioMuted
      ? 'Микрофон временно не передаёт звук.'
      : state.camera && state.videoMuted ? 'Камера временно не передаёт изображение.' : '';
    id('reader-takes').disabled = active;
    toggle.setAttribute('aria-checked', String(voiceOn));
    toggle.disabled = view.classList.contains('no-script');
    for (const button of zoomControls.querySelectorAll('[data-zoom]')) {
      const preset = button.dataset.zoom;
      button.setAttribute('aria-pressed', String(preset === String(state.zoom)));
    }
    if (running && timer === null) {
      updateClock();
      timer = setInterval(updateClock, 250);
    } else if (!running && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (cameraChanged) {
      setPromptVisible(true);
      setOptionsOpen(false);
      follower.refresh();
    }
    if (cameraChanged || wasPresenting !== (voiceOn || active)) {
      wasPresenting = voiceOn || active;
      reveal();
    }
    if (running !== wasRecording) {
      wasRecording = running;
      onRecordingChange(running);
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
    try {
      await capture.enableCamera();
      return token === cameraEpoch && capture.getState().camera;
    }
    catch (error) { if (token === cameraEpoch) notify(error.message); }
    finally { if (token === cameraEpoch) { opening = false; render(); } }
  }

  function stopVoice(keepModel = false) {
    ++voiceEpoch;
    voiceOn = false;
    heard = '';
    clearTimeout(quietTimer);
    follower.stop();
    speech.stop({ keepModel });
    capture.releaseVoice();
    message.textContent = '';
  }
  function voiceFailed(error) {
    stopVoice();
    toggle.dataset.state = 'error';
    message.textContent = error.message + ' Нажмите кнопку голоса для повтора.';
  }
  async function toggleVoice() {
    if (voiceOn) {
      stopVoice(true);
      if (restoreTempo && capture.getState().camera) resumeTempo();
      return;
    }
    const token = ++voiceEpoch;
    voiceOn = true;
    restoreTempo = capture.getState().camera && ['playing', 'countdown'].includes(view.dataset.phase);
    onVoiceStart();
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
  zoomControls.addEventListener('click', async event => {
    const button = event.target.closest('button[data-zoom]');
    if (!button) return;
    try { await capture.setZoom(button.dataset.zoom); }
    catch (error) { notify(error.message); }
  });
  id('camera-off').addEventListener('click', toggleCamera);
  preview.addEventListener('loadeddata', () => render());
  preview.addEventListener('playing', () => render());
  promptToggle.addEventListener('click', () => setPromptVisible(view.classList.contains('prompt-hidden')));
  optionsToggle.addEventListener('click', () => setOptionsOpen(!view.classList.contains('camera-settings-open')));
  view.addEventListener('keydown', event => {
    if (event.key === 'Escape' && view.classList.contains('camera-settings-open')) {
      setOptionsOpen(false);
      optionsToggle.focus();
    }
  });
  record.addEventListener('click', () => {
    setOptionsOpen(false);
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
