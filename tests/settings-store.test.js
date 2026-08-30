import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_STATE,
  STORAGE_KEY,
  getSafeStorage,
  loadAppState,
  normalizeState,
  saveAppState,
} from '../js/settings-store.js';

class MemoryStorage {
  constructor() {
    this.values = new Map();
    this.failReads = false;
    this.failWrites = false;
  }

  getItem(key) {
    if (this.failReads) throw new Error('storage unavailable');
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    if (this.failWrites) throw new Error('quota exceeded');
    this.values.set(key, String(value));
  }
}

test('normalizeState preserves a script and clamps unsafe settings', () => {
  const state = normalizeState({
    version: 1,
    script: 'Мой текст',
    settings: {
      wpm: 9_999,
      fontSize: 2,
      lineHeight: 9,
      columnWidth: 1,
      countdown: 99,
      theme: 'light',
      mirror: 1,
      focusMode: false,
    },
  });

  assert.deepEqual(state, {
    version: 1,
    script: 'Мой текст',
    settings: {
      wpm: 400,
      fontSize: 28,
      lineHeight: 2.2,
      columnWidth: 50,
      countdown: 3,
      theme: 'light',
      mirror: true,
      focusMode: false,
    },
  });
});

test('normalizeState uses defaults for an incompatible schema', () => {
  assert.deepEqual(normalizeState({ version: 99, script: 'Старый текст' }), DEFAULT_STATE);
});

test('normalizeState rejects unknown theme and countdown values', () => {
  const state = normalizeState({
    version: 1,
    script: '',
    settings: { theme: 'neon', countdown: 4 },
  });

  assert.equal(state.settings.theme, 'dark');
  assert.equal(state.settings.countdown, 3);
  assert.equal(state.settings.focusMode, true);
});

test('loadAppState restores valid JSON without recovery warning', () => {
  const storage = new MemoryStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({
    version: 1,
    script: 'Сохранено',
    settings: { wpm: 180 },
  }));

  const result = loadAppState(storage);

  assert.equal(result.state.script, 'Сохранено');
  assert.equal(result.state.settings.wpm, 180);
  assert.equal(result.state.settings.fontSize, DEFAULT_STATE.settings.fontSize);
  assert.equal(result.recovered, false);
});

test('loadAppState recovers from malformed JSON', () => {
  const storage = new MemoryStorage();
  storage.setItem(STORAGE_KEY, '{broken');

  const result = loadAppState(storage);

  assert.deepEqual(result.state, DEFAULT_STATE);
  assert.equal(result.recovered, true);
});

test('loadAppState recovers when storage access throws', () => {
  const storage = new MemoryStorage();
  storage.failReads = true;

  const result = loadAppState(storage);

  assert.deepEqual(result.state, DEFAULT_STATE);
  assert.equal(result.recovered, true);
});

test('saveAppState writes normalized state and reports success', () => {
  const storage = new MemoryStorage();

  assert.equal(saveAppState(storage, {
    version: 1,
    script: '  Не обрезать пробелы  ',
    settings: { wpm: 999 },
  }), true);

  const saved = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.equal(saved.script, '  Не обрезать пробелы  ');
  assert.equal(saved.settings.wpm, 400);
});

test('saveAppState reports a storage write failure', () => {
  const storage = new MemoryStorage();
  storage.failWrites = true;

  assert.equal(saveAppState(storage, DEFAULT_STATE), false);
});

test('getSafeStorage survives a blocked localStorage getter', () => {
  const windowRef = {};
  Object.defineProperty(windowRef, 'localStorage', {
    get() { throw new DOMException('blocked', 'SecurityError'); },
  });

  assert.equal(getSafeStorage(windowRef), null);
});
