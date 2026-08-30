import test from 'node:test';
import assert from 'node:assert/strict';

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
} from '../js/teleprompter-model.js';

test('countWords counts Russian words separated by mixed whitespace', () => {
  assert.equal(countWords('Раз два\nтри\tчетыре'), 4);
});

test('countWords ignores surrounding whitespace', () => {
  assert.equal(countWords('  Камера работает.  '), 2);
});

test('countWords returns zero for blank input', () => {
  assert.equal(countWords('  \n\t '), 0);
});

test('estimateDurationMs maps 120 words at 120 WPM to one minute', () => {
  assert.equal(estimateDurationMs(120, 120), 60_000);
});

test('estimateDurationMs returns zero for an empty script', () => {
  assert.equal(estimateDurationMs(0, 150), 0);
});

test('estimateDurationMs rejects a non-positive speed', () => {
  assert.equal(estimateDurationMs(100, 0), 0);
});

test('formatClock rounds down milliseconds into mm:ss', () => {
  assert.equal(formatClock(61_999), '01:01');
});

test('formatReaderTime reports elapsed and remaining time', () => {
  assert.deepEqual(formatReaderTime(0.25, 80_000), {
    compact: '00:20 / −01:00',
    accessible: 'Прошло 00:20, осталось 01:00',
  });
});

test('formatWordCount uses Russian plural forms', () => {
  assert.equal(formatWordCount(1), '1 слово');
  assert.equal(formatWordCount(2), '2 слова');
  assert.equal(formatWordCount(5), '5 слов');
  assert.equal(formatWordCount(11), '11 слов');
  assert.equal(formatWordCount(21), '21 слово');
});

test('clamp replaces non-finite input with the lower bound', () => {
  assert.equal(clamp(Number.NaN, 10, 20), 10);
});

test('progressToScrollTop maps clamped progress onto the available range', () => {
  assert.equal(progressToScrollTop(0.25, 1_000, 200), 200);
  assert.equal(progressToScrollTop(2, 1_000, 200), 800);
  assert.equal(progressToScrollTop(0.5, 100, 200), 0);
});

test('reader shortcuts ignore focused interactive and editable elements', () => {
  assert.equal(shouldIgnoreReaderShortcut({ tagName: 'INPUT' }, 'KeyR'), true);
  assert.equal(shouldIgnoreReaderShortcut({ tagName: 'TEXTAREA' }, 'ArrowUp'), true);
  assert.equal(shouldIgnoreReaderShortcut({ tagName: 'DIV', isContentEditable: true }, 'KeyM'), true);
  assert.equal(shouldIgnoreReaderShortcut({ tagName: 'BUTTON' }, 'Space'), true);
  assert.equal(shouldIgnoreReaderShortcut({ tagName: 'A' }, 'Enter'), true);
  assert.equal(shouldIgnoreReaderShortcut({ tagName: 'BUTTON' }, 'KeyR'), false);
  assert.equal(shouldIgnoreReaderShortcut({ tagName: 'DIV', isContentEditable: false }, 'Space'), false);
});

test('repeated one-shot shortcuts are ignored while repeatable adjustments remain active', () => {
  for (const code of ['Space', 'KeyR', 'KeyF', 'KeyM']) {
    assert.equal(shouldIgnoreShortcutRepeat(code, true), true);
    assert.equal(shouldIgnoreShortcutRepeat(code, false), false);
  }
  for (const code of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
    assert.equal(shouldIgnoreShortcutRepeat(code, true), false);
  }
});
