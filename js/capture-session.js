import { createCameraFraming } from './camera-framing.js';
import { discoverCameraLenses } from './camera-lenses.js';

// The camera owns a pair of device tracks. Speech borrows the microphone;
// releasing that lease must never stop or replace the recorder's audio track.
function cameraConstraints(portrait, fps, facing, deviceId, exactFacing) {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    facingMode: { [exactFacing ? 'exact' : 'ideal']: facing },
    width: { ideal: portrait ? 1080 : 1920 }, height: { ideal: portrait ? 1920 : 1080 },
    frameRate: { ideal: fps },
    resizeMode: { ideal: 'none' },
  };
}
// Let the encoder select an AVC level suitable for the actual resolution and fps.
const formats = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm'];
const live = track => track?.readyState === 'live';
const cancelled = () => new DOMException('Запрос отменён.', 'AbortError');

function videoConstraintsOnly(track) {
  const { advanced = [], ...basic } = track.getConstraints?.() ?? {};
  // Some browsers handle zoom and video-format constraints in separate subsystems.
  for (const key of ['zoom', 'pan', 'tilt']) delete basic[key];
  const entries = advanced.map(({ zoom, pan, tilt, ...video }) => video).filter(item => Object.keys(item).length);
  return entries.length ? { ...basic, advanced: entries } : basic;
}

function recordingProfile(source, track, fps) {
  const settings = track?.getSettings?.() ?? {};
  const sourceWidth = track ? source?.videoWidth || settings.width || 0 : 0;
  const sourceHeight = track ? source?.videoHeight || settings.height || 0 : 0;
  const sourceFps = settings.frameRate > 0 ? settings.frameRate : 0;
  // A 9:16 crop of a horizontal frame contains fewer pixels. Emit an exact,
  // even-sized 9:16 frame up to Full HD, without stretching that crop to 1080p.
  const units = Math.floor(Math.min(60, sourceWidth / 18, sourceHeight / 32));
  return { sourceWidth, sourceHeight, sourceFps,
    outputWidth: units * 18, outputHeight: units * 32, outputFps: Math.min(fps, sourceFps || fps) };
}

function deviceError(error) {
  switch (error?.name) {
    case 'NotAllowedError':
    case 'SecurityError': return new Error('Разрешите доступ к запрошенным устройствам в настройках сайта.');
    case 'NotFoundError': return new Error('Камера или микрофон не найдены. Проверьте подключение.');
    case 'OverconstrainedError': return new Error('Браузер не предоставил выбранную камеру или режим.');
    case 'NotReadableError': return new Error('Камера или микрофон заняты. Закройте другое приложение и повторите.');
    default: return new Error('Не удалось получить доступ к устройству. Проверьте разрешения и повторите.');
  }
}

// Draw only the decoded camera image. Its intrinsic dimensions already include
// presentation rotation. The framing controller is shared with the live preview.
function portraitTrack(source, deviceTrack, framing, profile, makeCanvas, onFrameError) {
  if (!source || source.readyState < 2 || !source.videoWidth || !source.videoHeight) {
    throw new Error('Дождитесь изображения с камеры и нажмите запись ещё раз.');
  }
  const { outputWidth, outputHeight, outputFps, sourceFps } = profile;
  if (!outputWidth) throw new Error('Камера не передаёт кадр подходящего размера.');
  const settings = deviceTrack.getSettings?.() ?? {};
  if (settings.width === outputWidth && settings.height === outputHeight &&
      source.videoWidth === outputWidth && source.videoHeight === outputHeight && sourceFps && sourceFps <= outputFps) {
    const checkSize = () => {
      if (source.videoWidth !== outputWidth || source.videoHeight !== outputHeight) {
        onFrameError('Ориентация камеры изменилась. Завершаем вертикальный дубль.');
      }
    };
    source.addEventListener('resize', checkSize);
    return { track: deviceTrack, close: () => source.removeEventListener('resize', checkSize) };
  }
  const canvas = makeCanvas();
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context || !canvas.captureStream) throw new Error('Этот браузер не поддерживает вертикальную видеозапись.');
  const [track] = canvas.captureStream(outputFps).getVideoTracks();
  if (!live(track)) throw new Error('Не удалось создать вертикальную видеодорожку.');
  const useVideoFrames = typeof source.requestVideoFrameCallback === 'function';
  let callback = null;

  function schedule() {
    callback = useVideoFrames ? source.requestVideoFrameCallback(next) : requestAnimationFrame(next);
  }
  function next() {
    try { framing.draw(context, outputWidth, outputHeight); schedule(); }
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
  try { framing.draw(context, outputWidth, outputHeight); schedule(); }
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
  frameRate: initialFrameRate = 30,
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
  let frameRate = Number(initialFrameRate) === 60 ? 60 : 30;
  let facingMode = 'user';
  let lenses = {};
  let cameraChanging = false;
  let nativeZoomPending = 0;
  const attemptedSensorUpgrade = new WeakMap();
  const endedHandlers = new Map();
  const framing = createCameraFraming(previewElement, changed);

  function getState() {
    const optics = framing.state();
    return {
      ...optics, frameRate, facingMode, cameraChanging: cameraChanging || nativeZoomPending > 0,
      ...recordingProfile(previewElement, video, frameRate),
      ...(take ? take.profile : {}),
      wideAvailable: optics.hardwareWideAvailable || !!lenses.wideDeviceId || optics.zoom === 0.5,
      oneAvailable: optics.zoom === 1 || optics.hardwareWideAvailable || !!lenses.standardDeviceId,
      wideRequiresSwitch: !optics.hardwareWideAvailable,
      canFlip: !!lenses.canFlip,
      camera: cameraWanted && Boolean(preview) && live(mic) && (live(video) || cameraChanging),
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
    if (!cameraWanted && (video || preview)) {
      drop(video);
      video = preview = null;
      lenses = {};
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

  async function openDevices({ audio, withVideo, facing = facingMode, deviceId = '', exactFacing = false }, current) {
    if (!mediaDevices?.getUserMedia || !Stream) {
      throw new Error('Доступ к устройствам требует HTTPS и браузера с поддержкой камеры и микрофона.');
    }
    const constraints = { audio, video: withVideo ? cameraConstraints(mobilePortrait(), frameRate, facing, deviceId, exactFacing) : false };
    let acquired;
    try {
      if (withVideo && mediaDevices.getSupportedConstraints?.().zoom) {
        try {
          acquired = await mediaDevices.getUserMedia({ ...constraints,
            video: { ...constraints.video, facingMode: { exact: facing }, zoom: true } });
        } catch (error) {
          if (!current() || !['NotAllowedError', 'NotFoundError', 'OverconstrainedError', 'TypeError', 'SecurityError'].includes(error?.name)) throw error;
        }
      }
      acquired ??= await mediaDevices.getUserMedia(constraints);
    } catch (error) {
      if (!current()) throw cancelled();
      throw deviceError(error);
    }
    const videoTrack = acquired.getVideoTracks()[0], audioTrack = acquired.getAudioTracks()[0];
    if (!current() || (audio && !live(audioTrack)) || (withVideo && !live(videoTrack))) {
      acquired.getTracks().forEach(track => track.stop());
      if (!current()) throw cancelled();
      throw new Error('Браузер не вернул запрошенную аудио- или видеодорожку.');
    }
    const settings = videoTrack?.getSettings?.() ?? {};
    if ((deviceId && settings.deviceId && settings.deviceId !== deviceId) ||
        (exactFacing && settings.facingMode && settings.facingMode !== facing)) {
      acquired.getTracks().forEach(track => track.stop());
      throw new Error('Браузер вернул другую камеру. Выбранный объектив недоступен.');
    }
    // Stop extra tracks in a nonstandard stream. Retain only requested tracks.
    for (const track of acquired.getTracks()) {
      if (!(withVideo && track === videoTrack) && !(audio && track === audioTrack)) track.stop();
    }
    return { videoTrack, audioTrack };
  }

  async function useCamera(track, facing, current) {
    try {
      const fps = track.getSettings?.().frameRate;
      if (current() && frameRate === 60 && fps > 0 && fps < 59.7 && track.applyConstraints &&
          track.getCapabilities?.().frameRate?.max >= 59.7) {
        try { await track.applyConstraints({ ...videoConstraintsOnly(track), frameRate: { min: 59.7, ideal: 60 } }); }
        catch { /* Device may only offer 60 in a format currently unavailable. */ }
      }
      const discovered = await discoverCameraLenses(mediaDevices, track, facing);
      if (!current() || !live(track)) throw cancelled();
      video = track;
      watch(track);
      if (lenses.facingMode === discovered.facingMode && discovered.activePreset === 0.5) {
        discovered.standardDeviceId ||= lenses.standardDeviceId;
      }
      lenses = discovered;
      facingMode = discovered.facingMode || facing;
      framing.attach(track, discovered.activePreset);
      preview = new Stream([mic, video]);
    } catch (error) {
      drop(track);
      throw error;
    }
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
        const { audioTrack, videoTrack } = await openDevices({ audio: needAudio, withVideo: needVideo }, current);
        if (!current()) {
          if (needAudio) audioTrack.stop();
          if (needVideo) videoTrack.stop();
          throw cancelled();
        }
        if (needAudio) { mic = audioTrack; watch(mic); }
        if (needVideo) await useCamera(videoTrack, facingMode, current);
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

  function changeCamera(action) {
    if (take || cameraChanging || nativeZoomPending) return Promise.reject(new Error('Измените камеру или частоту кадров между дублями.'));
    const version = cameraVersion;
    const current = () => version === cameraVersion;
    cameraChanging = true;
    changed();
    const request = queue.then(() => {
      if (!current()) throw cancelled();
      return action(current);
    }).finally(() => {
      cameraChanging = false;
      cleanUnused();
      changed();
      queueMicrotask(improveLandscapeCrop);
    });
    queue = request.catch(() => {});
    return request;
  }

  async function replaceCamera(facing, deviceId, current, expectedPreset) {
    const previous = { facing: facingMode, deviceId: lenses.activeDeviceId, zoom: framing.state().zoom };
    // Some iPhones allow only one open camera. Release this video track while
    // the shared microphone continues to feed speech. Restore the old lens on failure.
    drop(video);
    video = null;
    async function select(side, id, expected) {
      const { videoTrack } = await openDevices({ audio: false, withVideo: true, facing: side, deviceId: id, exactFacing: true }, current);
      await useCamera(videoTrack, side, current);
      if (facingMode !== side || (expected && framing.state().zoom !== expected)) {
        drop(video);
        video = null;
        throw new Error('Браузер не подтвердил переключение объектива.');
      }
    }
    try { await select(facing, deviceId, expectedPreset); }
    catch (error) {
      if (!current()) throw cancelled();
      try {
        await select(previous.facing, previous.deviceId);
        if (previous.zoom !== framing.state().zoom && framing.state().hardwareWideAvailable) await framing.setZoom(previous.zoom);
      } catch {
        if (!current()) throw cancelled();
        cameraWanted = false;
        preview = null;
        lenses = {};
        framing.attach(null);
        throw new Error('Не удалось открыть объектив или вернуться к предыдущему. Включите камеру ещё раз.');
      }
      throw error;
    }
  }

  function setFacingMode(facing) {
    if (facing !== 'user' && facing !== 'environment') return Promise.reject(new Error('Неизвестная камера.'));
    if (facingMode === facing) return Promise.resolve();
    return changeCamera(async current => {
      if (live(video)) await replaceCamera(facing, '', current);
      else facingMode = facing;
    });
  }

  async function setZoom(value) {
    const preset = Number(value);
    if (![0.5, 1].includes(preset)) return Promise.reject(new Error('Неизвестный масштаб камеры.'));
    if (!live(video) || cameraChanging) return Promise.reject(new Error('Дождитесь включения камеры.'));
    if (framing.state().hardwareWideAvailable) {
      // The same source track stays connected to the recorder throughout.
      nativeZoomPending++;
      changed();
      try { return await framing.setZoom(preset); }
      catch (error) {
        if (take || !lenses.wideDeviceId || framing.state().hardwareWideAvailable) throw error;
      } finally { nativeZoomPending--; changed(); }
    }
    if (preset === framing.state().zoom) return Promise.resolve();
    const id = preset === 0.5 ? lenses.wideDeviceId : lenses.standardDeviceId;
    if (!id) return Promise.reject(new Error('Эта камера не предоставляет выбранный угол обзора.'));
    return changeCamera(current => replaceCamera(facingMode, id, current, preset));
  }

  function setFrameRate(value) {
    const fps = Number(value);
    if (![30, 60].includes(fps)) return Promise.reject(new Error('Выберите 30 или 60 кадров/с.'));
    if (frameRate === fps) return Promise.resolve();
    return changeCamera(async current => {
      // A preference is allowed to negotiate down, including 60 -> 30.
      // Merge with the current constraints to preserve zoom and lens settings.
      const track = video;
      if (!live(track)) { frameRate = fps; return; }
      const initialZoom = track.getSettings?.().zoom;
      const currentPreset = framing.state().zoom;
      const defaults = cameraConstraints(mobilePortrait(), fps, facingMode, '', false);
      let applied = false;
      if (track.applyConstraints) {
        // A 4K30 source may also provide 1080p60. Prefer the selected cadence.
        const base = { ...videoConstraintsOnly(track), width: defaults.width, height: defaults.height };
        for (const rate of [{ min: fps * 0.995, ideal: fps }, { ideal: fps }]) {
          try { await track.applyConstraints({ ...base, frameRate: rate }); applied = true; }
          catch { /* Fall back to the best rate available. */ }
          if (!current()) throw cancelled();
          if (applied) break;
        }
      }
      if (applied) {
        frameRate = fps;
        if (Number.isFinite(initialZoom) && initialZoom !== track.getSettings().zoom) {
          // Format changes may reset a camera's zoom. Report the new default
          // immediately, then restore the requested wider angle if possible.
          framing.attach(track, lenses.activePreset);
          if (currentPreset !== lenses.activePreset && framing.state().hardwareWideAvailable) {
            await framing.setZoom(currentPreset);
          }
        }
      } else {
        const previousRate = frameRate;
        frameRate = fps;
        try { await replaceCamera(facingMode, lenses.activeDeviceId, current); }
        catch (error) { frameRate = previousRate; throw error; }
        if (currentPreset !== framing.state().zoom && framing.state().hardwareWideAvailable) {
          await framing.setZoom(currentPreset);
        }
      }
    });
  }

  // In portrait, some browsers still supply a landscape sensor. A center crop
  // of 1920×1080 contains only ~608×1080 pixels. If the device advertises a
  // taller native source, try it once per track and cadence, before recording.
  function improveLandscapeCrop() {
    const track = video;
    if (!live(track) || !cameraWanted || take || cameraChanging || nativeZoomPending || !track.applyConstraints ||
        previewElement?.srcObject !== preview || !previewElement.videoHeight ||
        previewElement.videoWidth <= previewElement.videoHeight || previewElement.videoHeight >= 1920 ||
        framing.state().zoom !== lenses.activePreset || attemptedSensorUpgrade.get(track) === frameRate) return;
    const caps = track.getCapabilities?.() ?? {};
    if (!(caps.width?.max >= 1920 && caps.height?.max >= 1920)) return;
    attemptedSensorUpgrade.set(track, frameRate);
    void changeCamera(async current => {
      if (!current() || video !== track) return;
      const settings = track.getSettings?.() ?? {};
      const goalRate = Math.min(frameRate, settings.frameRate || frameRate);
      const base = videoConstraintsOnly(track);
      try {
        await track.applyConstraints({ ...base, width: { ideal: Math.min(3840, caps.width.max) },
          height: { min: 1920, ideal: Math.min(2160, caps.height.max) },
          frameRate: { min: goalRate * 0.995, ideal: frameRate }, resizeMode: { ideal: 'none' } });
        if (!current()) return;
        const actual = track.getSettings?.().frameRate;
        if (actual && actual < goalRate * 0.995) await track.applyConstraints(base);
        if (current() && Number.isFinite(settings.zoom) && settings.zoom !== track.getSettings?.().zoom) {
          framing.attach(track, lenses.activePreset);
        }
      } catch { /* The original camera format remains usable. */ }
    }).catch(() => {});
  }
  previewElement?.addEventListener?.('loadedmetadata', improveLandscapeCrop);
  previewElement?.addEventListener?.('resize', improveLandscapeCrop);

  function startRecording() {
    if (take) throw new Error('Сначала завершите текущую запись.');
    if (cameraChanging || nativeZoomPending) throw new Error('Дождитесь переключения камеры.');
    if (!getState().camera) throw new Error('Сначала включите камеру и разрешите микрофон.');
    if (mic.muted) throw new Error('Микрофон пока не передаёт звук. Проверьте его и повторите старт.');
    if (!Recorder) throw new Error('В этом браузере запись видео недоступна.');
    const profile = recordingProfile(previewElement, video, frameRate);
    const portrait = portraitTrack(previewElement, video, framing, profile, makeCanvas, message => {
      onError(message || 'Не удалось получить следующий кадр. Завершаем дубль.');
      void stopRecording();
    });
    let recorder;
    try {
      const output = new Stream([mic, portrait.track]);
      // MediaRecorder rates are encoder targets. Leave room for motion at 60 fps.
      const videoBitsPerSecond = Math.max(1_000_000, Math.round(profile.outputWidth * profile.outputHeight * profile.outputFps * 0.18));
      const rates = { videoBitsPerSecond, audioBitsPerSecond: 192_000 };
      for (const mimeType of formats.filter(type => Recorder.isTypeSupported?.(type))) {
        try { recorder = new Recorder(output, { mimeType, ...rates }); break; } catch { /* Try another encoder. */ }
      }
      recorder ??= new Recorder(output, rates);
    } catch {
      portrait.close();
      throw new Error('Браузеру не удалось настроить запись видео со звуком.');
    }
    const entry = { recorder, portrait, profile, chunks: [], phase: 'starting', startedAt: null, stoppedAt: null, timeout: null };
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
    releaseVoice, disableCamera, startRecording, stopRecording, close, getState, setZoom, setFrameRate, setFacingMode,
  };
}
