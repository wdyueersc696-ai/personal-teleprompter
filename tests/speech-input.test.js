import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechInput } from '../js/speech-input.js';

function fixture({ deferModel = false } = {}) {
  const statuses = [], errors = [], results = [], models = [], recognizers = [];
  const track = Object.assign(new EventTarget(), {
    readyState: 'live',
    stop() { throw new Error('recognition must never stop the shared microphone'); },
  });
  const stream = { getAudioTracks: () => [track] };
  const source = { connect() {}, disconnect() { this.disconnected = true; } };
  const context = {
    state: 'running', sampleRate: 48000, destination: {},
    resume: async () => {}, close: async () => { context.state = 'closed'; },
    audioWorklet: { addModule: async () => {} },
    createMediaStreamSource(s) { assert.equal(s, stream); return source; },
  };
  const processor = { connect() {}, disconnect() {}, port: { postMessage() {}, close() {} } };
  class Emitter {
    listeners = new Map();
    on(name, listener) { this.listeners.set(name, listener); }
    emit(name, arg) { this.listeners.get(name)?.(arg); }
  }
  class Model extends Emitter {
    worker = Object.assign(new EventTarget(), { terminate() { this.terminated = true; } });
    constructor() {
      super();
      models.push(this);
      if (!deferModel) queueMicrotask(() => { this.ready = true; this.emit('load', { result: true }); });
    }
    KaldiRecognizer = class extends Emitter {
      constructor() { super(); recognizers.push(this); }
      remove() { this.removed = true; }
      acceptWaveformFloat() { this.frames = (this.frames || 0) + 1; }
    };
  }
  const input = createSpeechInput({
    onResult: (value) => results.push(value), onStatus: (value) => statuses.push(value),
    onError: (error) => errors.push(error),
    openContext: () => context, openProcessor: () => processor, loadVosk: async () => ({ Model }),
  });
  return { stream, track, statuses, errors, results, models, recognizers, input, processor, source, context };
}

test('recognition uses the given stream, groups partial/final updates and releases only its own resources', async () => {
  const f = fixture();
  f.input.prepare();
  await f.input.start(f.stream);
  f.processor.port.onmessage({ data: { epoch: 1, pcm: new Float32Array(4096) } });
  assert.equal(f.recognizers[0].frames, 1);
  f.recognizers[0].emit('partialresult', { result: { partial: 'один два' } });
  f.recognizers[0].emit('result', { result: { text: 'один два три' } });
  f.recognizers[0].emit('partialresult', { result: { partial: 'проверка' } });
  assert.deepEqual(f.results.map(({ final, segment }) => [final, segment]), [[false, 1], [true, 1], [false, 2]]);
  f.input.stop();
  f.recognizers[0].emit('partialresult', { result: { partial: 'после остановки' } });
  assert.equal(f.results.length, 3);
  assert.equal(f.track.readyState, 'live');
  assert.equal(f.source.disconnected, true);
  assert.equal(f.models[0].worker.terminated, true);
  assert.equal(f.context.state, 'closed');
  assert.deepEqual(f.statuses, ['loading', 'listening', 'off']);
});

test('seeking discards stale PCM and interim/final results without restarting the microphone or model', async () => {
  const f = fixture();
  await f.input.start(f.stream);
  f.input.resetSegment();
  f.processor.port.onmessage({ data: { epoch: 1, pcm: new Float32Array(4096) } });
  assert.equal(f.recognizers[1].frames, undefined);
  f.recognizers[0].emit('result', { result: { text: 'старый результат' } });
  f.recognizers[1].emit('partialresult', { result: { partial: 'новые слова' } });
  assert.deepEqual(f.results, [{ text: 'новые слова', final: false, segment: 2 }]);
  assert.equal(f.models.length, 1);
  f.input.stop();
});

test('worker failure stops recognition while leaving the camera stream live', async () => {
  const f = fixture();
  await f.input.start(f.stream);
  f.models[0].worker.dispatchEvent(new Event('error'));
  assert.equal(f.errors.length, 1);
  assert.equal(f.statuses.at(-1), 'off');
  assert.equal(f.track.readyState, 'live');
});

test('cancelling a model load terminates its worker and cannot resurrect the session', async () => {
  const f = fixture({ deferModel: true });
  const pending = f.input.start(f.stream);
  await new Promise((resolve) => setImmediate(resolve));
  f.input.stop();
  await assert.rejects(pending, { name: 'AbortError' });
  f.models[0].emit('load', { result: true });
  assert.equal(f.models[0].worker.terminated, true);
  assert.equal(f.recognizers.length, 0);
  assert.deepEqual(f.errors, []);
});

test('startup error from Vosk rejects cleanly and keeps the borrowed track alive', async () => {
  const f = fixture({ deferModel: true });
  const pending = f.input.start(f.stream);
  await new Promise((resolve) => setImmediate(resolve));
  f.models[0].emit('error', { error: 'Cannot mount IndexedDB' });
  await assert.rejects(pending, /русскую модель/);
  assert.equal(f.models[0].worker.terminated, true);
  assert.equal(f.track.readyState, 'live');
});
