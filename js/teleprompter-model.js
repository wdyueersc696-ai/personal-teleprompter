export function clamp(value, minimum, maximum) {
  const lower = Math.min(minimum, maximum);
  const upper = Math.max(minimum, maximum);

  if (!Number.isFinite(value)) {
    return lower;
  }

  return Math.min(upper, Math.max(lower, value));
}

export function countWords(text) {
  const normalized = String(text ?? '').trim();
  return normalized ? normalized.split(/\s+/u).length : 0;
}

export function estimateDurationMs(wordCount, wordsPerMinute) {
  if (!Number.isFinite(wordCount) || !Number.isFinite(wordsPerMinute)) {
    return 0;
  }

  if (wordCount <= 0 || wordsPerMinute <= 0) {
    return 0;
  }

  return (wordCount / wordsPerMinute) * 60_000;
}

export function formatClock(milliseconds) {
  const safeMilliseconds = Number.isFinite(milliseconds)
    ? Math.max(0, milliseconds)
    : 0;
  const totalSeconds = Math.floor(safeMilliseconds / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatReaderTime(progress, durationMs) {
  const safeDuration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  const safeProgress = clamp(progress, 0, 1);
  const elapsed = formatClock(safeDuration * safeProgress);
  const remaining = formatClock(safeDuration * (1 - safeProgress));

  return {
    compact: `${elapsed} / −${remaining}`,
    accessible: `Прошло ${elapsed}, осталось ${remaining}`,
  };
}

export function formatWordCount(wordCount) {
  const count = Number.isFinite(wordCount) ? Math.max(0, Math.floor(wordCount)) : 0;
  const lastTwoDigits = count % 100;
  const lastDigit = count % 10;
  let noun = 'слов';

  if (lastTwoDigits < 11 || lastTwoDigits > 14) {
    if (lastDigit === 1) noun = 'слово';
    if (lastDigit >= 2 && lastDigit <= 4) noun = 'слова';
  }

  return `${count} ${noun}`;
}

export function progressToScrollTop(progress, scrollHeight, clientHeight) {
  const safeScrollHeight = Number.isFinite(scrollHeight) ? Math.max(0, scrollHeight) : 0;
  const safeClientHeight = Number.isFinite(clientHeight) ? Math.max(0, clientHeight) : 0;
  const availableDistance = Math.max(0, safeScrollHeight - safeClientHeight);

  return clamp(progress, 0, 1) * availableDistance;
}

export function shouldIgnoreReaderShortcut(target, code) {
  if (!target) return false;
  if (target.isContentEditable) return true;

  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return true;
  return ['A', 'BUTTON'].includes(target.tagName) && ['Enter', 'Space'].includes(code);
}

export function shouldIgnoreShortcutRepeat(code, repeat) {
  return Boolean(repeat && ['Space', 'KeyR', 'KeyF', 'KeyM'].includes(code));
}
