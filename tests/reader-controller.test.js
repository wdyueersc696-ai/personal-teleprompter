import test from 'node:test';
import assert from 'node:assert/strict';

import { createReaderController, readerPrimaryAction } from '../js/reader-controller.js';

function createTimerHarness() {
  let nextId = 1;
  const callbacks = new Map();

  return {
    schedule(callback) {
      const id = nextId;
      nextId += 1;
      callbacks.set(id, callback);
      return id;
    },
    cancelSchedule(id) {
      callbacks.delete(id);
    },
    runNext() {
      const first = callbacks.entries().next();
      if (first.done) return false;
      const [id, callback] = first.value;
      callbacks.delete(id);
      callback();
      return true;
    },
    get pending() {
      return callbacks.size;
    },
  };
}

function createHarness() {
  const timers = createTimerHarness();
  const states = [];
  const controller = createReaderController({
    schedule: timers.schedule.bind(timers),
    cancelSchedule: timers.cancelSchedule.bind(timers),
    onState: (state) => states.push(state),
  });
  return { controller, timers, states };
}

test('start counts down once per second before playing', () => {
  const { controller, timers, states } = createHarness();

  controller.start(3);
  timers.runNext();
  timers.runNext();
  timers.runNext();

  assert.deepEqual(states, [
    { phase: 'countdown', countdownRemaining: 3 },
    { phase: 'countdown', countdownRemaining: 2 },
    { phase: 'countdown', countdownRemaining: 1 },
    { phase: 'playing', countdownRemaining: 0 },
  ]);
});

test('start with countdown off begins immediately', () => {
  const { controller, timers } = createHarness();

  controller.start(0);

  assert.deepEqual(controller.getState(), { phase: 'playing', countdownRemaining: 0 });
  assert.equal(timers.pending, 0);
});

test('toggle pauses and resumes without another countdown', () => {
  const { controller } = createHarness();

  controller.start(0);
  controller.toggle();
  assert.deepEqual(controller.getState(), { phase: 'paused', countdownRemaining: 0 });
  controller.toggle();

  assert.deepEqual(controller.getState(), { phase: 'playing', countdownRemaining: 0 });
});

test('toggle during countdown cancels the timer and pauses', () => {
  const { controller, timers } = createHarness();

  controller.start(5);
  controller.toggle();

  assert.deepEqual(controller.getState(), { phase: 'paused', countdownRemaining: 0 });
  assert.equal(timers.pending, 0);
});

test('finish cancels countdown and enters finished state', () => {
  const { controller, timers } = createHarness();

  controller.start(3);
  controller.finish();

  assert.deepEqual(controller.getState(), { phase: 'finished', countdownRemaining: 0 });
  assert.equal(timers.pending, 0);
});

test('reset returns any state to idle', () => {
  const { controller } = createHarness();

  controller.start(0);
  controller.reset();

  assert.deepEqual(controller.getState(), { phase: 'idle', countdownRemaining: 0 });
});

test('toggle does not restart a finished reading', () => {
  const { controller } = createHarness();

  controller.start(0);
  controller.finish();

  assert.equal(controller.toggle(), false);
  assert.deepEqual(controller.getState(), { phase: 'finished', countdownRemaining: 0 });
});

test('reconciling a paused manual scroll at the end marks reading finished', () => {
  const { controller } = createHarness();

  controller.start(0);
  controller.pause();
  controller.reconcileProgress(1);

  assert.deepEqual(controller.getState(), { phase: 'finished', countdownRemaining: 0 });
});

test('reconciling backward movement from the end returns to paused', () => {
  const { controller } = createHarness();

  controller.start(0);
  controller.finish();
  controller.reconcileProgress(0.8);

  assert.deepEqual(controller.getState(), { phase: 'paused', countdownRemaining: 0 });
});

test('primary reader action describes the real action for each state', () => {
  assert.deepEqual(readerPrimaryAction('idle'), { label: 'Пуск', pressed: false });
  assert.deepEqual(readerPrimaryAction('countdown'), { label: 'Отменить отсчёт', pressed: true });
  assert.deepEqual(readerPrimaryAction('playing'), { label: 'Пауза', pressed: true });
  assert.deepEqual(readerPrimaryAction('paused'), { label: 'Пуск', pressed: false });
  assert.deepEqual(readerPrimaryAction('finished'), { label: 'Сначала', pressed: false });
});
