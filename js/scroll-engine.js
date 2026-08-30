import { clamp } from './teleprompter-model.js';

const MAX_FRAME_DELTA_MS = 250;

function roundedProgress(value) {
  return Math.round(clamp(value, 0, 1) * 1_000_000_000_000) / 1_000_000_000_000;
}

export function createScrollEngine({
  requestFrame,
  cancelFrame,
  now,
  onProgress = () => {},
  onFinish = () => {},
}) {
  let durationMs = 0;
  let progress = 0;
  let isPlaying = false;
  let frameId = null;
  let lastTimestamp = null;
  let finishReported = false;

  function scheduleFrame() {
    frameId = requestFrame(tick);
  }

  function finish() {
    isPlaying = false;
    frameId = null;
    lastTimestamp = null;
    if (!finishReported) {
      finishReported = true;
      onFinish();
    }
  }

  function tick(timestamp) {
    frameId = null;
    if (!isPlaying) return;

    const currentTimestamp = Number.isFinite(timestamp) ? timestamp : now();
    const elapsed = Math.max(0, currentTimestamp - lastTimestamp);
    const activeElapsed = Math.min(elapsed, MAX_FRAME_DELTA_MS);
    lastTimestamp = currentTimestamp;
    progress = roundedProgress(progress + (activeElapsed / durationMs));
    onProgress(progress);

    if (progress >= 1) {
      finish();
      return;
    }

    scheduleFrame();
  }

  function setDuration(nextDurationMs) {
    if (Number.isFinite(nextDurationMs) && nextDurationMs > 0) {
      durationMs = nextDurationMs;
    }
    return durationMs;
  }

  function play(nextDurationMs = durationMs) {
    setDuration(nextDurationMs);
    if (isPlaying || durationMs <= 0 || progress >= 1) {
      return false;
    }

    isPlaying = true;
    lastTimestamp = now();
    scheduleFrame();
    return true;
  }

  function pause() {
    if (!isPlaying) return false;

    isPlaying = false;
    lastTimestamp = null;
    if (frameId !== null) {
      cancelFrame(frameId);
      frameId = null;
    }
    return true;
  }

  function seek(nextProgress) {
    const wasPlaying = isPlaying;
    progress = roundedProgress(nextProgress);
    finishReported = progress >= 1 ? finishReported : false;
    onProgress(progress);

    if (wasPlaying) {
      lastTimestamp = now();
      if (progress >= 1) {
        if (frameId !== null) cancelFrame(frameId);
        finish();
      }
    }

    return progress;
  }

  function restart() {
    finishReported = false;
    return seek(0);
  }

  function getSnapshot() {
    return { progress, isPlaying, durationMs };
  }

  return {
    play,
    pause,
    seek,
    restart,
    setDuration,
    getSnapshot,
  };
}
