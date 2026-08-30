export function createReaderController({
  schedule,
  cancelSchedule,
  onState = () => {},
}) {
  let state = { phase: 'idle', countdownRemaining: 0 };
  let timerId = null;

  function snapshot() {
    return { ...state };
  }

  function publish(phase, countdownRemaining = 0) {
    state = { phase, countdownRemaining };
    onState(snapshot());
  }

  function clearCountdownTimer() {
    if (timerId !== null) {
      cancelSchedule(timerId);
      timerId = null;
    }
  }

  function runCountdownTick() {
    timerId = null;
    if (state.phase !== 'countdown') return;

    const nextValue = state.countdownRemaining - 1;
    if (nextValue <= 0) {
      publish('playing');
      return;
    }

    publish('countdown', nextValue);
    timerId = schedule(runCountdownTick, 1_000);
  }

  function start(countdownSeconds = 0) {
    if (state.phase === 'playing' || state.phase === 'countdown') {
      return false;
    }

    clearCountdownTimer();
    if (state.phase === 'paused') {
      publish('playing');
      return true;
    }

    const seconds = Number.isFinite(Number(countdownSeconds))
      ? Math.max(0, Math.floor(Number(countdownSeconds)))
      : 0;

    if (seconds === 0) {
      publish('playing');
      return true;
    }

    publish('countdown', seconds);
    timerId = schedule(runCountdownTick, 1_000);
    return true;
  }

  function pause() {
    if (state.phase !== 'playing' && state.phase !== 'countdown') {
      return false;
    }

    clearCountdownTimer();
    publish('paused');
    return true;
  }

  function toggle() {
    if (state.phase === 'playing' || state.phase === 'countdown') {
      return pause();
    }
    if (state.phase === 'paused' || state.phase === 'idle') {
      return start(0);
    }
    return false;
  }

  function finish() {
    clearCountdownTimer();
    publish('finished');
  }

  function reset() {
    clearCountdownTimer();
    publish('idle');
  }

  function reconcileProgress(progress) {
    const value = Number(progress);
    if (!Number.isFinite(value)) return false;

    if (value >= 1 && state.phase !== 'finished') {
      finish();
      return true;
    }

    if (value < 1 && state.phase === 'finished') {
      publish('paused');
      return true;
    }

    return false;
  }

  return {
    start,
    toggle,
    pause,
    finish,
    reset,
    reconcileProgress,
    cancelCountdown: pause,
    getState: snapshot,
  };
}

export function readerPrimaryAction(phase) {
  if (phase === 'countdown') return { label: 'Отменить отсчёт', pressed: true };
  if (phase === 'playing') return { label: 'Пауза', pressed: true };
  if (phase === 'finished') return { label: 'Сначала', pressed: false };
  return { label: 'Пуск', pressed: false };
}
