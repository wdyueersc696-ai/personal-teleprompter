import { createVoiceMatcher } from './voice-match.js';

// Keep the article as one selectable text node. A Range maps a matched
// source word to its actual wrapped line at the current font and width.
export function createVoiceScroll({ article, viewport, seek, onAnchor, onFinish }) {
  let matcher;
  let frame = 0;
  let target = 0;
  let manualTimer = 0;
  let touching = false;
  let lastWord = null;

  function stopMotion() {
    cancelAnimationFrame(frame);
    frame = 0;
  }
  function wordRange(index) {
    const word = matcher.words[index];
    const node = article.firstChild;
    if (!word || !node) return null;
    const range = document.createRange();
    range.setStart(node, word.start);
    range.setEnd(node, word.end);
    return range;
  }
  function lineAt(index) {
    return wordRange(index)?.getClientRects()[0]?.top ?? 0;
  }
  function markWord(index) {
    const highlights = globalThis.CSS?.highlights;
    if (!highlights || !globalThis.Highlight) return;
    const range = wordRange(index);
    if (range) highlights.set('voice-word', new Highlight(range));
    else highlights.delete('voice-word');
  }
  function atReadingLine() {
    if (!matcher.words.length) return 0;
    const y = lineAt(0) + viewport.scrollTop;
    let low = 0, high = matcher.words.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (lineAt(mid) < y - 2) low = mid + 1;
      else high = mid;
    }
    return low;
  }
  function align() {
    if (!matcher) return;
    markWord(matcher.reset(atReadingLine()));
    lastWord = null;
    onAnchor();
  }
  function userMoved() {
    if (!matcher) return;
    stopMotion();
    clearTimeout(manualTimer);
    manualTimer = setTimeout(() => {
      manualTimer = 0;
      if (!touching) align();
    }, 140);
  }
  function startGesture() {
    if (!matcher) return;
    touching = true;
    stopMotion();
  }
  function endGesture() {
    if (!touching) return;
    touching = false;
    userMoved();
  }
  viewport.addEventListener('touchstart', startGesture, { passive: true });
  viewport.addEventListener('touchend', endGesture);
  viewport.addEventListener('touchcancel', endGesture);
  viewport.addEventListener('wheel', userMoved, { passive: true });

  function goToWord(position) {
    markWord(position);
    const distance = viewport.scrollHeight - viewport.clientHeight;
    const end = position >= matcher.words.length;
    if (distance <= 0) {
      if (end) onFinish();
      return;
    }
    target = end ? distance : Math.min(distance, Math.max(0, lineAt(position) - lineAt(0)));
    lastWord = position;
    stopMotion();
    const from = viewport.scrollTop;
    const start = performance.now();
    const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 :
      Math.min(480, 110 + Math.abs(target - from) / 1.8);
    const tick = time => {
      const t = duration ? Math.max(0, Math.min(1, (time - start) / duration)) : 1;
      seek((from + (target - from) * (1 - (1 - t) ** 2)) / distance);
      if (t < 1) frame = requestAnimationFrame(tick);
      else { frame = 0; if (end) onFinish(); }
    };
    frame = requestAnimationFrame(tick);
  }
  function stop() {
    globalThis.CSS?.highlights?.delete('voice-word');
    stopMotion();
    clearTimeout(manualTimer);
    manualTimer = 0;
    touching = false;
    matcher = null;
    lastWord = null;
  }
  return {
    start() {
      stop();
      matcher = createVoiceMatcher(article.textContent);
      matcher.reset(atReadingLine());
    },
    accept(text, final) {
      if (!matcher || touching || manualTimer) return null;
      const result = matcher.accept(text, { final });
      if (result.advanced) goToWord(result.position);
      return result;
    },
    refresh() {
      if (matcher && lastWord !== null && !manualTimer && !touching) goToWord(lastWord);
    },
    userMoved, stop,
  };
}
