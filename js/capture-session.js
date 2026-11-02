import { createCameraFraming } from './camera-framing.js';

// The camera owns a pair of device tracks. Speech borrows the microphone;
// releasing that lease must never stop or replace the recorder's audio track.
function frontCamera(portrait) {
  return {
    facingMode: { ideal: 'user' },
    width: { ideal: portrait ? 720 : 1280 }, height: { ideal: portrait ? 1280 : 720 },
    resizeMode: { ideal: 'none' },
  };
}
const formats = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/webm;codecs=vp8,opus', 'video/mp4', 'video/webm'];
const live = track => track?.readyState === 'live';
const cancelled = () => new DOMException('Запрос отменён.', 'AbortError');

function deviceError(error) {
  switch (error?.name) {
    case 'NotAllowedError':
    case 'SecurityError': return new Error('Разрешите доступ к запрошенным устройствам в настройках сайта.');
    case 'NotFoundError': return new Error('Камера или микрофон не найдены. Проверьте подключение.');
    case 'NotReadableError': return new Error('Камера или микрофон заняты. Закройте другое приложение и повторите.');
    default: return new Error('Не удалось получить доступ к устройству. Проверьте разрешения и повторите.');
  }
}

// Draw only the decoded camera image. Its intrinsic dimensions already include
// presentation rotation. The framing controller is shared with the live preview.
function portraitTrack(source, framing, makeCanvas, onFrameError) {
  if (!source || source.readyState < 2 || !source.videoWidth || !source.videoHeight) {
    throw new Error('Дождитесь изображения с камеры и нажмите запись ещё раз.');
  }
  const canvas = makeCanvas();
  canvas.width = framing.width;
  canvas.height = framing.height;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context || !canvas.captureStream) throw new Error('Этот браузер не поддерживает вертикальную видеозапись.');
  const [track] = canvas.captureStream(30).getVideoTracks();
  if (!live(track)) throw new Error('Не удалось создать вертикальную видеодорожку.');
  const useVideoFrames = typeof source.requestVideoFrameCallback === 'function';
  let callback = null;

  function schedule() {
    callback = useVideoFrames ? source.requestVideoFrameCallback(next) : requestAnimationFrame(next);
  }
  function next() {
    try { framing.draw(context); schedule(); }
    catch { onFrameError(); }
  }
  function close() {
    if (callback !== null) {
      if (useVideoFrames) source.cancelVideoFrameCallback(callback);
      else cancelAnimationFrame(callback);
      callback = null;
    }
    track.stop();
    canvas.width = canvas.height = 0;
  }
  try { framing.draw(context); schedule(); }
  catch {
    close();
    throw new Error('Не удалось получить вертикальный кадр с камеры.');
  }
  return { track, close };
}

export function createCaptureSession({
  mediaDevices = globalThis.navigator?.mediaDevices,
  Recorder = globalThis.MediaRecorder,
  Stream = globalThis.MediaStream,
  previewElement,
  makeCanvas = () => document.createElement('canvas'),
  mobilePortrait = () => globalThis.matchMedia?.('(orientation: portrait) and (pointer: coarse)').matches === true,
  now = () => performance.now(),
  onChange = () => {}, onError = () => {}, onResult = () => {},
} = {}) {
  let mic = null;
  let video = null;
  let preview = null;
  let take = null;
  let cameraWanted = false;
  let voiceWanted = false;
  let cameraVersion = 0;
  let voiceVersion = 0;
  let queue = Promise.resolve();
  const endedHandlers = new Map();
  const framing = createCameraFraming(previewElement, changed);

  function getState() {
    return {
      ...framing.state(),
      camera: cameraWanted && Boolean(preview) && live(mic) && live(video),
      voice: voiceWanted && live(mic),
      audioMuted: live(mic) && mic.muted === true,
      videoMuted: live(video) && video.muted === true,
      stream: preview,
      recording: take?.phase ?? 'idle',
      elapsedMs: take?.startedAt != null ? Math.max(0, (take.stoppedAt ?? now()) - take.startedAt) : 0,
    };
  }

  function changed() { onChange(getState()); }

  function drop(track) {
    if (!track) return;
    const handler = endedHandlers.get(track);
    if (handler) track.removeEventListener('ended', handler);
    track.removeEventListener('mute', changed);
    track.removeEventListener('unmute', changed);
    endedHandlers.delete(track);
    track.stop();
  }

  function cleanUnused() {
    if (take) return;
    if (!cameraWanted && video) {
      drop(video);
      video = preview = null;
      framing.attach(null);
    }
    if (!cameraWanted && !voiceWanted) {
      drop(mic);
      mic = null;
    }
  }

  function watch(track) {
    const ended = () => {
      if (track === mic) {
        voiceWanted = false;
        ++voiceVersion;
      }
      cameraWanted = false;
      ++cameraVersion;
      onError(track.kind === 'audio' ? 'Потерян доступ к микрофону.' : 'Потерян доступ к камере.');
      if (take) void stopRecording();
      cleanUnused();
      changed();
    };
    track.addEventListener('ended', ended);
    track.addEventListener('mute', changed);
    track.addEventListener('unmute', changed);
    endedHandlers.set(track, ended);
  }

  function acquire(forCamera) {
    if (forCamera) cameraWanted = true;
    else voiceWanted = true;
    const version = forCamera ? cameraVersion : voiceVersion;
    const current = () => forCamera ? version === cameraVersion : version === voiceVersion;
    // Serialize permission requests. A voice request arriving while camera
    // permission is pending will reuse the track returned by the first prompt.
    const request = queue.then(async () => {
      if (!current()) throw cancelled();
      const needAudio = !live(mic);
      const needVideo = forCamera && !live(video);
      if (needAudio || needVideo) {
        if (!mediaDevices?.getUserMedia || !Stream) {
          throw new Error('Доступ к устройствам требует HTTPS и браузера с поддержкой камеры и микрофона.');
        }
        let acquired;
        const constraints = { audio: needAudio, video: needVideo ? frontCamera(mobilePortrait()) : false };
        try {
          // Request the optional device zoom permission when the browser knows
          // this constraint. The ordinary camera/recording path also works without it.
          if (needVideo && mediaDevices.getSupportedConstraints?.().zoom) {
            try {
              // A rear camera may advertise a wider zoom range. Prefer a selfie
              // camera with zoom, then a regular selfie camera as below.
              acquired = await mediaDevices.getUserMedia({
                ...constraints, video: { ...constraints.video, facingMode: { exact: 'user' }, zoom: true },
              });
            } catch (error) {
              if (!current() || !['NotAllowedError', 'NotFoundError', 'OverconstrainedError', 'TypeError', 'SecurityError'].includes(error?.name)) throw error;
            }
          }
          if (!acquired) acquired = await mediaDevices.getUserMedia(constraints);
        } catch (error) {
          if (!current()) throw cancelled();
          throw deviceError(error);
        }
        const audioTrack = acquired.getAudioTracks()[0];
        const videoTrack = acquired.getVideoTracks()[0];
        if (!current() || (needAudio && !live(audioTrack)) || (needVideo && !live(videoTrack))) {
          acquired.getTracks().forEach(track => track.stop());
          if (!current()) throw cancelled();
          throw new Error('Браузер не вернул запрошенную аудио- или видеодорожку.');
        }
        for (const track of acquired.getTracks()) {
          if (needAudio && track === audioTrack) mic = track;
          else if (needVideo && track === videoTrack) {
            video = track;
            framing.attach(track);
          }
          else { track.stop(); continue; }
          watch(track);
        }
      }
      if (forCamera && !preview) preview = new Stream([mic, video]);
      changed();
      return forCamera ? preview : mic;
    }).catch(error => {
      if (current()) {
        if (forCamera) cameraWanted = false;
        else voiceWanted = false;
        cleanUnused();
        changed();
      }
      throw error;
    });
    queue = request.catch(() => {});
    return request;
  }

  function releaseVoice() {
    ++voiceVersion;
    voiceWanted = false;
    cleanUnused();
    changed();
  }

  function disableCamera() {
    if (take) return false;
    ++cameraVersion;
    cameraWanted = false;
    cleanUnused();
    changed();
    return true;
  }

  function startRecording() {
    if (take) throw new Error('Сначала завершите текущую запись.');
    if (!getState().camera) throw new Error('Сначала включите камеру и разрешите микрофон.');
    if (mic.muted) throw new Error('Микрофон пока не передаёт звук. Проверьте его и повторите старт.');
    if (!Recorder) throw new Error('В этом браузере запись видео недоступна.');
    const portrait = portraitTrack(previewElement, framing, makeCanvas, () => {
      onError('Не удалось получить следующий кадр. Завершаем дубль.');
      void stopRecording();
    });
    let recorder;
    try {
      const mimeType = formats.find(type => Recorder.isTypeSupported?.(type));
      const output = new Stream([mic, portrait.track]);
      recorder = mimeType ? new Recorder(output, { mimeType }) : new Recorder(output);
    } catch {
      portrait.close();
      throw new Error('Браузеру не удалось настроить запись видео со звуком.');
    }
    const entry = { recorder, portrait, chunks: [], phase: 'starting', startedAt: null, stoppedAt: null, timeout: null };
    entry.done = new Promise(resolve => { entry.resolve = resolve; });
    take = entry;
    recorder.onstart = () => {
      if (take !== entry || entry.phase === 'stopping') return;
      clearTimeout(entry.timeout);
      entry.startedAt = now();
      entry.phase = 'recording';
      changed();
    };
    recorder.ondataavailable = event => {
      if (event.data?.size) entry.chunks.push(event.data);
    };
    recorder.onerror = () => {
      onError('Ошибка видеозаписи. Сохраняем доступный фрагмент.');
      if (take === entry) void stopRecording();
    };
    recorder.onstop = () => finish(entry);
    try {
      entry.timeout = setTimeout(() => {
        onError('Браузер не подтвердил начало записи. Попробуйте ещё раз.');
        void stopRecording();
      }, 15000);
      recorder.start(1000);
    } catch {
      detach(entry);
      take = null;
      entry.resolve(null);
      throw new Error('Не удалось начать запись. Проверьте камеру и микрофон.');
    }
    changed();
  }

  function detach({ recorder, portrait, timeout }) {
    clearTimeout(timeout);
    recorder.onstart = recorder.onstop = recorder.onerror = recorder.ondataavailable = null;
    portrait.close();
  }

  function finish(entry) {
    if (entry !== take) return;
    detach(entry);
    take = null;
    let blob = null;
    if (entry.chunks.length) {
      try {
        blob = new Blob(entry.chunks, { type: entry.chunks[0].type || entry.recorder.mimeType });
      } catch {
        onError('Недостаточно памяти для формирования видео.');
      }
    } else {
      onError('Браузер завершил запись без видеофайла. Попробуйте короткий дубль.');
    }
    entry.chunks.length = 0;
    cleanUnused();
    entry.resolve(blob);
    if (blob) onResult(blob);
    changed();
  }

  function stopRecording() {
    const entry = take;
    if (!entry) return Promise.resolve(null);
    if (entry.phase === 'stopping') return entry.done;
    entry.phase = 'stopping';
    entry.stoppedAt = now();
    clearTimeout(entry.timeout);
    // A mobile interruption can prevent the last stop event from arriving.
    entry.timeout = setTimeout(() => {
      onError('Браузер не подтвердил завершение записи. Проверьте сохранённый фрагмент.');
      finish(entry);
    }, 10000);
    try {
      if (entry.recorder.state !== 'inactive') entry.recorder.stop();
    } catch {
      onError('Не удалось штатно завершить запись.');
      if (entry.recorder.state !== 'inactive') {
        // Device shutdown is the final way to stop a failed encoder. Its
        // dataavailable/stop events may still carry a recoverable fragment.
        cameraWanted = voiceWanted = false;
        ++cameraVersion;
        ++voiceVersion;
        drop(video);
        drop(mic);
        entry.portrait.close();
        video = mic = preview = null;
        framing.attach(null);
      }
    }
    changed();
    return entry.done;
  }

  async function close() {
    ++cameraVersion;
    ++voiceVersion;
    cameraWanted = voiceWanted = false;
    const result = take ? await stopRecording() : null;
    cleanUnused();
    changed();
    return result;
  }

  return {
    enableCamera: () => acquire(true), acquireVoice: () => acquire(false),
    releaseVoice, disableCamera, startRecording, stopRecording, close, getState, setZoom: framing.setZoom,
  };
}
