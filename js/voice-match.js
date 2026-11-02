// DOM Range offsets use UTF-16 indices. Keep the original spelling and offsets
// separate from the expanded tokens used to compare written and spoken numbers.
const WORD = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu;
const UNITS = 'ноль один два три четыре пять шесть семь восемь девять десять одиннадцать двенадцать тринадцать четырнадцать пятнадцать шестнадцать семнадцать восемнадцать девятнадцать'.split(' ');
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];
const ALIASES = new Map(Object.entries({
  одна: 'один', одно: 'один', две: 'два', нуль: 'ноль',
  тысяча: 'тысяч', тысячи: 'тысяч', тысячу: 'тысяч',
}));
const WEAK = new Set('а и у к в с о на от по не но из за об под э эм ну'.split(' '));

function numberTokens(value) {
  if (value === 0) return [UNITS[0]];
  const result = [];
  if (value >= 1000) {
    const thousands = Math.floor(value / 1000);
    if (thousands > 1) result.push(...numberTokens(thousands));
    result.push('тысяч');
    value %= 1000;
  }
  if (value >= 100) {
    result.push(HUNDREDS[Math.floor(value / 100)]);
    value %= 100;
  }
  if (value >= 20) {
    result.push(TENS[Math.floor(value / 10)]);
    value %= 10;
  }
  if (value) result.push(UNITS[value]);
  return result;
}

function compareTokens(word) {
  const lower = word.normalize('NFC').toLowerCase().replaceAll('ё', 'е');
  if (/^(?:0|[1-9]\d{0,5})$/.test(lower)) return numberTokens(Number(lower));
  return [ALIASES.get(lower) ?? lower];
}

// Score a short suffix of the current utterance against the script near the
// current reading position. Local alignment can restart after an aside. A gap
// of four unmatched tokens always breaks the chain of evidence.
function findAlignment(script, heard, cursor, anchor, final) {
  const tail = heard.slice(-16);
  const left = Math.max(0, cursor - 22);
  const right = Math.min(script.length, cursor + 24);
  const expectedStart = Math.min(cursor, anchor + heard.length - tail.length);
  let previous = [];
  let best = null;
  for (let i = 0; i < tail.length; i++) {
    const row = [];
    for (let j = left; j < right; j++) {
      const col = j - left;
      const diag = previous[col];
      const equal = tail[i] === script[j];
      let cell;
      if (equal) {
        cell = {
          score: (diag?.score ?? 0) + 4,
          hits: (diag?.hits ?? 0) + 1,
          strong: (diag?.strong ?? false) || !WEAK.has(script[j]),
          start: diag?.start ?? j, first: diag?.first ?? i, gap: 0,
        };
        const last = i === tail.length - 1;
        const lead = cell.start - cursor;
        const required = lead > 8 ? 4 : lead > 2 ? 3 : 2;
        const singleton = final && heard.length === 1 && j === cursor
          && (script.length === 1 || (tail[i].length >= 3 && cell.strong));
        const coverage = cell.hits / Math.max(i - cell.first + 1, j - cell.start + 1);
        if ((last || i === tail.length - 2) && lead <= 12 && coverage >= 0.60
          && (singleton || (cell.strong && cell.hits >= required))) {
          const rank = cell.score - (last ? 0 : 2)
            - Math.min(2.5, Math.abs(cell.start - expectedStart) * 0.12);
          if (!best || rank > best.rank || (rank === best.rank && j + 1 < best.end)) {
            best = { rank, end: j + 1 };
          }
        }
      }
      // One substitution (an ASR mistake), extra spoken word, or skipped script word.
      for (const [source, cost] of [[diag, 3], [previous[col + 1], 2], [row[col], 2]]) {
        if (!source || source.gap >= 3 || source.score <= cost) continue;
        const score = source.score - cost;
        if (!cell || score > cell.score) cell = { ...source, score, gap: source.gap + 1 };
      }
      row[col + 1] = cell;
    }
    previous = row;
  }
  return best;
}

export function createVoiceMatcher(source) {
  const words = [];
  const script = [];
  const ends = [0];
  for (const { 0: text, index: start } of String(source).matchAll(WORD)) {
    words.push({ text, start, end: start + text.length });
    script.push(...compareTokens(text));
    ends.push(script.length);
  }
  let position = 0;
  let anchor = 0;
  let previousPhrase = [];
  let lastMatched = false;

  function reset(nextWordIndex = 0) {
    position = Math.max(0, Math.min(words.length, Math.trunc(nextWordIndex) || 0));
    anchor = ends[position];
    previousPhrase = [];
    lastMatched = false;
    return position;
  }

  function accept(transcript, { final = false } = {}) {
    const heard = Array.from(String(transcript).matchAll(WORD), ([text]) => compareTokens(text)).flat();
    const before = position;
    // Engines revise interim results, re-emit them as final, and sometimes
    // repeat the start of the previous utterance in a new result.
    if (!heard.length) {
      if (final) anchor = ends[position];
      return { position, advanced: false, matched: false };
    }
    if (!heard.every((word, index) => previousPhrase[index] === word)) {
      const match = findAlignment(script, heard, ends[position], anchor, final);
      lastMatched = Boolean(match);
      if (match) {
        while (position < words.length && ends[position + 1] <= match.end) position++;
      }
      // A one-word interim lacks enough evidence, but its final can qualify.
      if (match || final || heard.length > 1) previousPhrase = heard;
    }
    if (final) anchor = ends[position];
    return { position, advanced: position > before, matched: lastMatched };
  }
  return { words, reset, accept, getPosition: () => position };
}
