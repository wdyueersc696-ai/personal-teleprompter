import test from 'node:test';
import assert from 'node:assert/strict';
import { readTakeFrameRate } from '../js/take-frame-rate.js';

const words = (...values) => {
  const bytes = Buffer.alloc(4 * values.length);
  values.forEach((v, i) => bytes.writeUInt32BE(v, 4 * i));
  return bytes;
};
function box(name, ...parts) {
  const data = Buffer.concat(parts);
  return Buffer.concat([words(8 + data.length), Buffer.from(name), data]);
}
function track(id, kind, timing) {
  return box('trak', box('tkhd', words(0, 0, 0, id)),
    box('mdia', box('hdlr', words(0, 0), Buffer.from(kind)), box('mdhd', words(0, 0, 0, 60000)),
      box('minf', box('stbl', box('stts', timing)))));
}
const audio = track(1, 'soun', words(0, 1, 97, 1024));
const mp4 = (...boxes) => new Blob(boxes, { type: 'video/mp4' });

test('flat MP4 counts video samples only and averages variable frame times', async () => {
  const file = mp4(box('moov', audio, track(3, 'vide', words(0, 2, 30, 1000, 15, 2000))));
  assert.equal(await readTakeFrameRate(file), 45);
});

test('fragmented MP4 uses sample durations, track defaults and gaps on the video timeline', async () => {
  const frag = (start, run) => box('moof', box('traf', box('tfhd', words(8, 3, 1000)),
    box('tfdt', words(0x01000000, 0, start)), box('trun', run)));
  const init = box('moov', audio, track(3, 'vide', words(0, 0)));
  const file = mp4(init, frag(6000, words(0, 15)), box('mdat', Buffer.alloc(8192)),
    frag(36000, words(0x100, 2, 15000, 15000)));
  const read = file.slice.bind(file);
  file.slice = (start, end) => { assert.ok(end - start < 1024, 'must skip media data'); return read(start, end); };
  assert.equal(await readTakeFrameRate(file), 17);
});

test('truncated, unrecognised or deselected files never get a made-up fps', async () => {
  const init = box('moov', audio, track(3, 'vide', words(0, 1, 10, 2000)));
  assert.equal(await readTakeFrameRate(mp4(init.subarray(0, init.length - 2))), null);
  assert.equal(await readTakeFrameRate(new Blob([init], { type: 'video/webm' })), null);
  assert.equal(await readTakeFrameRate(mp4(init), () => false), null);
});
