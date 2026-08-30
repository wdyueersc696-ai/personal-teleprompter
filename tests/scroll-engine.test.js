import test from 'node:test';
import assert from 'node:assert/strict';

import { createScrollEngine } from '../js/scroll-engine.js';

function createFrameClock() {
  let timestamp = 0;
  let nextId = 1;
  const callbacks = new Map();

  return {
    api: {
      now: () => timestamp,
      requestFrame: (callback) => {
        const id = nextId;
        nextId += 1;
        callbacks.set(id, callback);
        return id;
      },
      cancelFrame: (id) => callbacks.delete(id),
    },
    step(milliseconds) {
      timestamp += milliseconds;
      const pending = [...callbacks.values()];
      callbacks.clear();
      pending.forEach((callback) => callback(timestamp));
    },
    advance(milliseconds, frameLength = 100) {
      let remaining = milliseconds;
      while (remaining > 0) {
        const elapsed = Math.min(frameLength, remaining);
        this.step(elapsed);
        remaining -= elapsed;
      }
    },
    get pendingFrames() {
      return callbacks.size;
    },
  };
}

function createHarness() {
  const clock = createFrameClock();
  const reported = [];
  let finishes = 0;
  const engine = createScrollEngine({
    ...clock.api,
    onProgress: (progress) => reported.push(progress),
    onFinish: () => { finishes += 1; },
  });

  return {
    clock,
    engine,
    reported,
    finishCount: () => finishes,
  };
}

test('play advances progress by elapsed active frame time', () => {
  const { clock, engine } = createHarness();

  engine.play(10_000);
  clock.advance(1_000);

  assert.equal(engine.getSnapshot().progress, 0.1);
  assert.equal(engine.getSnapshot().isPlaying, true);
});

test('pause and play resume without resetting progress', () => {
  const { clock, engine } = createHarness();

  engine.play(10_000);
  clock.advance(1_000);
  engine.pause();
  clock.advance(2_000);
  engine.play(10_000);
  clock.advance(1_000);

  assert.equal(engine.getSnapshot().progress, 0.2);
});

test('a delayed animation frame advances by at most 250 milliseconds', () => {
  const { clock, engine } = createHarness();

  engine.play(10_000);
  clock.step(5_000);

  assert.equal(engine.getSnapshot().progress, 0.025);
});

test('seek clamps progress and reports the new position', () => {
  const { engine, reported } = createHarness();

  engine.seek(1.5);

  assert.equal(engine.getSnapshot().progress, 1);
  assert.equal(reported.at(-1), 1);
});

test('setDuration preserves progress while changing future speed', () => {
  const { clock, engine } = createHarness();

  engine.play(10_000);
  clock.advance(1_000);
  engine.setDuration(20_000);
  clock.advance(1_000);

  assert.equal(engine.getSnapshot().progress, 0.15);
});

test('restart returns to the beginning and keeps the current play state', () => {
  const { clock, engine } = createHarness();

  engine.play(10_000);
  clock.advance(1_000);
  engine.restart();

  assert.deepEqual(engine.getSnapshot(), {
    progress: 0,
    isPlaying: true,
    durationMs: 10_000,
  });
});

test('reaching the end stops the engine and reports finish once', () => {
  const { clock, engine, finishCount } = createHarness();

  engine.play(500);
  clock.advance(1_000, 100);
  clock.advance(1_000, 100);

  assert.deepEqual(engine.getSnapshot(), {
    progress: 1,
    isPlaying: false,
    durationMs: 500,
  });
  assert.equal(finishCount(), 1);
});

test('pause cancels the pending frame', () => {
  const { clock, engine } = createHarness();

  engine.play(1_000);
  assert.equal(clock.pendingFrames, 1);
  engine.pause();

  assert.equal(clock.pendingFrames, 0);
});
