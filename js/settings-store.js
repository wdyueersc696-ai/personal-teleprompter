import { clamp } from './teleprompter-model.js';

export const STORAGE_KEY = 'personal-teleprompter/state-v1';

const DEFAULT_SETTINGS = Object.freeze({
  wpm: 150,
  fontSize: 52,
  lineHeight: 1.45,
  columnWidth: 86,
  countdown: 3,
  theme: 'dark',
  mirror: false,
  focusMode: true,
});

export const DEFAULT_STATE = Object.freeze({
  version: 1,
  script: '',
  settings: DEFAULT_SETTINGS,
});

export function getSafeStorage(windowRef) {
  try {
    return windowRef?.localStorage ?? null;
  } catch {
    return null;
  }
}

function defaultState() {
  return {
    version: DEFAULT_STATE.version,
    script: DEFAULT_STATE.script,
    settings: { ...DEFAULT_SETTINGS },
  };
}

function finiteNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeCountdown(value) {
  const numeric = Number(value);
  return [0, 3, 5].includes(numeric) ? numeric : DEFAULT_SETTINGS.countdown;
}

export function normalizeState(candidate) {
  if (!candidate || typeof candidate !== 'object' || candidate.version !== 1) {
    return defaultState();
  }

  const settings = candidate.settings && typeof candidate.settings === 'object'
    ? candidate.settings
    : {};

  return {
    version: 1,
    script: typeof candidate.script === 'string' ? candidate.script : '',
    settings: {
      wpm: Math.round(clamp(finiteNumber(settings.wpm, DEFAULT_SETTINGS.wpm), 50, 400)),
      fontSize: Math.round(clamp(finiteNumber(settings.fontSize, DEFAULT_SETTINGS.fontSize), 28, 96)),
      lineHeight: Math.round(
        clamp(finiteNumber(settings.lineHeight, DEFAULT_SETTINGS.lineHeight), 1.1, 2.2) * 100,
      ) / 100,
      columnWidth: Math.round(
        clamp(finiteNumber(settings.columnWidth, DEFAULT_SETTINGS.columnWidth), 50, 100),
      ),
      countdown: normalizeCountdown(settings.countdown),
      theme: settings.theme === 'light' ? 'light' : 'dark',
      mirror: Boolean(settings.mirror ?? DEFAULT_SETTINGS.mirror),
      focusMode: Boolean(settings.focusMode ?? DEFAULT_SETTINGS.focusMode),
    },
  };
}

export function loadAppState(storage) {
  try {
    const serialized = storage.getItem(STORAGE_KEY);
    if (serialized === null) {
      return { state: defaultState(), recovered: false };
    }

    const parsed = JSON.parse(serialized);
    const compatible = parsed && typeof parsed === 'object' && parsed.version === 1;

    return {
      state: normalizeState(parsed),
      recovered: !compatible,
    };
  } catch {
    return { state: defaultState(), recovered: true };
  }
}

export function saveAppState(storage, state) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(normalizeState(state)));
    return true;
  } catch {
    return false;
  }
}
