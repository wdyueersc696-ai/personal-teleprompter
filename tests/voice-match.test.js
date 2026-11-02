import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceMatcher } from '../js/voice-match.js';

test('offsets point to the exact DOM text, including a supplementary character before it', () => {
  const script = '🎥 «Ёлки»!\nОсень — 25 дней.';
  const m = createVoiceMatcher(script);
  assert.deepEqual(m.words.map(w => script.slice(w.start, w.end)), ['Ёлки', 'Осень', '25', 'дней']);
  assert.equal(m.words[0].start, 4);
  assert.equal(m.accept('елки, ОСЕНЬ! двадцать').position, 2);
  assert.equal(m.accept('ёлки осень двадцать пять дней', { final: true }).position, 4);
});

test('written and spoken forms of numbers match near the current location', () => {
  const m = createVoiceMatcher('Две тысячи двадцать четыре съёмки. Дальше 22 минуты.');
  assert.equal(m.accept('2024 съемки', { final: true }).position, 5);
  assert.equal(m.accept('дальше двадцать две минуты', { final: true }).position, 8);
});

test('interim changes, duplicate finals and rereading do not consume a subsequent copy', () => {
  const m = createVoiceMatcher('Первый дубль. Первый дубль. Следующий кадр.');
  assert.equal(m.accept('первый').advanced, false);
  assert.equal(m.accept('первый дубль').position, 2);
  for (const [text, final] of [['первый дубль', false], ['первый дубль', true], ['первый', false], ['первый дубль', true]]) {
    assert.equal(m.accept(text, { final }).advanced, false);
  }
  assert.equal(m.accept('первый дубль следующий кадр', { final: true }).position, 6);
});

test('local alignment tolerates fillers, repetition, omissions and a substitution', () => {
  const m = createVoiceMatcher('Сегодня мы проверяем камеру. Затем быстро начнём следующий большой дубль.');
  assert.equal(m.accept('сегодня мы мы э проверяем камеру', { final: true }).position, 4);
  assert.equal(m.accept('затем начнем следующий сложный дубль', { final: true }).position, 10);
});

test('unrelated speech, common prepositions, a single distant word and silence hold position', () => {
  const m = createVoiceMatcher('Я смотрю в камеру и на экран перед началом очередного длинного дубля.');
  for (const s of [' ', 'дубля', 'за окном шумит ветер', 'и на', 'запишите мне кофе']) {
    assert.deepEqual(m.accept(s, { final: true }), { position: 0, advanced: false, matched: false });
  }
});

test('a distinctive nearby passage reacquires alignment, a distant exact passage cannot', () => {
  const head = 'Один очень короткий дубль пропускаем. Следующий фрагмент звучит ясно.';
  const m = createVoiceMatcher(head + ' пока'.repeat(90) + ' секретный синий северный ветер');
  assert.equal(m.accept('секретный синий северный ветер').position, 0);
  assert.equal(m.accept('следующий фрагмент звучит ясно').position, 9);
});

test('manual seek backwards or forwards starts matching from that location', () => {
  const m = createVoiceMatcher('Начало первого кадра. ' + 'пусто '.repeat(40) + 'Конец второго кадра.');
  m.reset(43);
  assert.equal(m.accept('конец второго кадра').position, 46);
  m.reset(0);
  assert.equal(m.accept('начало первого кадра').position, 3);
  m.reset(999);
  assert.equal(m.getPosition(), m.words.length);
});

test('the final for a one-word script can advance after an identical interim', () => {
  const m = createVoiceMatcher('Да!');
  assert.equal(m.accept('да').advanced, false);
  assert.equal(m.accept('да', { final: true }).position, 1);
  assert.equal(m.accept('да', { final: true }).advanced, false);
});

test('continuous growing interim results keep following past the size of a search window', () => {
  const text = Array.from({length: 70}, (_, i) => 'слово' + i);
  const m = createVoiceMatcher(text.join(' '));
  for (let i = 2; i <= text.length; i++) {
    assert.equal(m.accept(text.slice(0, i).join(' ')).position, i);
  }
});
