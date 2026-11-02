import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaptureSession } from '../js/capture-session.js';

class Track extends EventTarget {
  constructor(kind) { super(); this.kind = kind; this.readyState = 'live'; }
  stop() { this.readyState = 'ended'; }
  disconnect() { this.stop(); this.dispatchEvent(new Event('ended')); }
}
class Stream {
  constructor(tracks) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
}

function harness(options = {}) {
  const calls = [], recorders = [], results = [], errors = [];
  const canvases = [];
  const frames = new Map();
  let nextFrame = 0;
  const previewElement = Object.assign(new EventTarget(), {
    videoWidth: 1280, videoHeight: 720, readyState: 4,
    style: { setProperty(name, value) { this[name] = value; } },
    requestVideoFrameCallback(fn) { frames.set(++nextFrame, fn); return nextFrame; },
    cancelVideoFrameCallback(id) { frames.delete(id); },
  });
  function makeCanvas() {
    const canvas = {
      track: new Track('video'), draws: [], fills: [],
      getContext() { return { drawImage: (...args) => this.draws.push(args), fillRect: (...args) => this.fills.push(args) }; },
      captureStream() { return new Stream([this.track]); },
    };
    canvases.push(canvas);
    return canvas;
  }
  let time = 100;
  class Recorder {
    static isTypeSupported(type) { return type.startsWith('video/webm'); }
    constructor(stream, { mimeType }) { Object.assign(this, { stream, mimeType, state: 'inactive' }); recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; }
    deliver(chunk = 'captured') {
      this.ondataavailable({ data: new Blob([chunk], { type: 'video/webm' }) });
      this.onstop();
    }
  }
  const session = createCaptureSession({
    now: () => time, onError: e => errors.push(e), onResult: b => results.push(b),
    Recorder, Stream, previewElement, makeCanvas, mediaDevices: {
      async getUserMedia(constraints) {
        calls.push(constraints);
        const kinds = ['audio', 'video'].filter(kind => constraints[kind]);
        return new Stream(kinds.map(kind => new Track(kind)));
      },
    },
    ...options,
  });
  return { session, calls, recorders, results, errors, canvases, frames, previewElement,
    tick: () => { time += 1234; } };
}

test('front camera and mic are acquired together; elapsed time starts on actual start event', async () => {
  const { session, calls, recorders, tick, results } = harness();
  const stream = await session.enableCamera();
  assert.deepEqual(calls.map(c => [c.audio, c.video.facingMode.ideal]), [[true, 'user']]);
  session.startRecording();
  const [rec] = recorders;
  assert.equal(rec.stream.getAudioTracks()[0], stream.getAudioTracks()[0]);
  assert.notEqual(rec.stream.getVideoTracks()[0], stream.getVideoTracks()[0]);
  assert.equal(session.getState().recording, 'starting');
  tick();
  assert.equal(session.getState().elapsedMs, 0);
  rec.onstart();
  tick();
  assert.equal(session.getState().elapsedMs, 1234);
  assert.equal(session.getState().recording, 'recording');
  const result = session.stopRecording();
  assert.equal(session.stopRecording(), result);
  assert.equal(session.getState().recording, 'stopping');
  tick();
  assert.equal(session.getState().elapsedMs, 1234);
  rec.deliver();
  assert.equal(await result, results[0]);
  assert.equal(results[0].type, 'video/webm');
  assert.equal(await results[0].text(), 'captured');
  assert.equal(session.getState().recording, 'idle');
  await session.close();
  assert.ok(stream.getTracks().every(t => t.readyState === 'ended'));
});

test('switching voice on/off while recording reuses the same live mic; camera cannot be removed', async () => {
  const { session, calls, recorders } = harness();
  const stream = await session.enableCamera();
  session.startRecording();
  recorders[0].onstart();
  const mic = await session.acquireVoice();
  assert.equal(mic, stream.getAudioTracks()[0]);
  session.releaseVoice();
  assert.equal(session.disableCamera(), false);
  assert.equal(mic.readyState, 'live');
  assert.equal(session.getState().recording, 'recording');
  assert.equal(await session.acquireVoice(), mic);
  assert.equal(calls.length, 1);
  const completion = session.close();
  assert.equal(mic.readyState, 'live');
  recorders[0].deliver();
  assert.ok(await completion);
  assert.equal(mic.readyState, 'ended');
});

test('voice first acquires audio alone; upgrading requests only video; removing camera preserves speech', async () => {
  const { session, calls } = harness();
  const mic = await session.acquireVoice();
  const stream = await session.enableCamera();
  assert.deepEqual(calls.map(c => [c.audio, !!c.video]), [[true, false], [false, true]]);
  assert.equal(mic, stream.getAudioTracks()[0]);
  assert.equal(session.disableCamera(), true);
  assert.equal(stream.getVideoTracks()[0].readyState, 'ended');
  assert.equal(mic.readyState, 'live');
  session.releaseVoice();
  assert.equal(mic.readyState, 'ended');
});

test('a queued voice request shares the camera permission request', async () => {
  const { session, calls } = harness();
  const [stream, mic] = await Promise.all([session.enableCamera(), session.acquireVoice()]);
  assert.equal(stream.getAudioTracks()[0], mic);
  assert.equal(calls.length, 1);
  await session.close();
});

test('leaving during permission request releases the late stream', async () => {
  let grant;
  const capture = new Promise(resolve => { grant = resolve; });
  const { session } = harness({ mediaDevices: { getUserMedia: () => capture } });
  const pending = session.enableCamera();
  await Promise.resolve();
  await session.close();
  const tracks = [new Track('audio'), new Track('video')];
  grant(new Stream(tracks));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.ok(tracks.every(track => track.readyState === 'ended'));
  assert.equal(session.getState().stream, null);
});

test('permission or recorder start failure never claims a recording is active', async () => {
  const denied = harness({ mediaDevices: { async getUserMedia() { throw new DOMException('', 'NotAllowedError'); } } });
  await assert.rejects(denied.session.enableCamera(), /Разрешите/);
  assert.equal(denied.session.getState().camera, false);
  assert.throws(() => denied.session.startRecording(), /включите/);
  const { session } = harness({ Recorder: class { start() { throw Error(); } } });
  await session.enableCamera();
  assert.throws(() => session.startRecording(), /начать/);
  assert.equal(session.getState().recording, 'idle');
  await session.close();
});

test('lost audio stops the take and extracts final chunks before releasing camera', async () => {
  const { session, recorders, errors, results } = harness();
  const stream = await session.enableCamera();
  const mic = await session.acquireVoice();
  session.startRecording();
  recorders[0].onstart();
  mic.disconnect();
  assert.equal(session.getState().recording, 'stopping');
  assert.equal(session.getState().voice, false);
  assert.match(errors[0], /микрофону/);
  recorders[0].deliver('part');
  assert.equal(await results[0].text(), 'part');
  assert.equal(stream.getVideoTracks()[0].readyState, 'ended');
});

test('an audio/video permission result missing the mic is not accepted', async () => {
  const video = new Track('video');
  const { session } = harness({ mediaDevices: { async getUserMedia() { return new Stream([video]); } } });
  await assert.rejects(session.enableCamera(), /дорожку/);
  assert.equal(video.readyState, 'ended');
});

test('empty recorder output produces an error rather than an invalid download', async () => {
  const { session, recorders, results, errors } = harness();
  await session.enableCamera();
  session.startRecording();
  const end = session.stopRecording();
  recorders[0].deliver('');
  assert.equal(await end, null);
  assert.deepEqual(results, []);
  assert.match(errors[0], /без видеофайла/);
  await session.close();
});

test('mobile portrait requests upright framing without mandatory size or orientation', async () => {
  const { calls, session } = harness({ mobilePortrait: () => true });
  await session.enableCamera();
  assert.deepEqual(calls[0].video, { facingMode: { ideal: 'user' }, width: { ideal: 720 }, height: { ideal: 1280 }, resizeMode: { ideal: 'none' } });
  await session.close();
});

test('a landscape sensor is center-cropped to 720 by 1280 and rotation cannot change the encoded frame', async () => {
  const { session, canvases, previewElement, frames, recorders } = harness();
  const stream = await session.enableCamera();
  session.startRecording();
  const [canvas] = canvases;
  const [rec] = recorders;
  assert.deepEqual([canvas.width, canvas.height], [720, 1280]);
  const coveredWidth = 1280 * (1280 / 720);
  assert.deepEqual(canvas.draws[0], [previewElement, (720 - coveredWidth) / 2, 0, coveredWidth, 1280]);
  assert.equal(rec.stream.getVideoTracks()[0], canvas.track);
  assert.equal(rec.stream.getAudioTracks()[0], stream.getAudioTracks()[0]);
  previewElement.videoWidth = 900;
  previewElement.videoHeight = 1800;
  const [id, paint] = frames.entries().next().value;
  frames.delete(id);
  paint();
  assert.deepEqual(canvas.draws[1], [previewElement, 0, -80, 720, 1440]);
  const stop = session.stopRecording();
  rec.deliver();
  await stop;
  assert.equal(canvas.track.readyState, 'ended');
  assert.equal(frames.size, 0);
  assert.ok(stream.getTracks().every(track => track.readyState === 'live'));
  await session.close();
});

test('recording waits for a decoded frame and never silently falls back to a landscape take', async () => {
  const { session, canvases, recorders, previewElement } = harness();
  await session.enableCamera();
  previewElement.readyState = 1;
  assert.throws(() => session.startRecording(), /Дождитесь изображения/);
  assert.equal(canvases.length, 0);
  assert.equal(recorders.length, 0);
  assert.equal(session.getState().camera, true);
  await session.close();
});

test('0.5× halves subject size, reveals extra source pixels, and switches back during the same take', async () => {
  const { session, previewElement, calls, recorders, canvases, frames } = harness();
  await session.enableCamera();
  for (const invalid of ['wide', 1.5, 2]) await assert.rejects(session.setZoom(invalid), /масштаб/);
  await session.setZoom('0.5');
  session.startRecording();
  const [canvas] = canvases;
  assert.equal(session.getState().zoom, 0.5);
  assert.equal(session.getState().zoomMode, 'digital');
  const halfWidth = 1280 * (1280 / 720) * 0.5;
  assert.equal(parseFloat(previewElement.style['--camera-image-width']), halfWidth / 720 * 100);
  assert.equal(previewElement.style['--camera-image-height'], '50%');
  assert.deepEqual(canvas.fills[0], [0, 0, 720, 1280]);
  assert.deepEqual(canvas.draws[0], [previewElement, (720 - halfWidth) / 2, 320, halfWidth, 640]);
  await session.setZoom('1');
  const [id, paint] = frames.entries().next().value;
  frames.delete(id);
  paint();
  assert.equal(session.getState().zoomMode, 'digital');
  assert.equal(previewElement.style['--camera-image-height'], '100%');
  assert.equal(canvas.draws[1][3], 2 * canvas.draws[0][3]);
  assert.equal(canvas.draws[1][4], 2 * canvas.draws[0][4]);
  assert.equal(recorders.length, 1);
  assert.equal(calls.length, 1);
  const stopping = session.close();
  recorders[0].deliver();
  await stopping;
});

test('uncropped 9:16 sources can use 0.5× with fields and keep that preset across metadata changes', async () => {
  const { session, previewElement, canvases, recorders } = harness();
  previewElement.videoWidth = 0;
  await session.enableCamera();
  await session.setZoom(0.5);
  previewElement.videoWidth = 960;
  previewElement.videoHeight = 1280;
  previewElement.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(previewElement.style['--camera-image-height'], '50%');
  previewElement.videoWidth = 720;
  previewElement.dispatchEvent(new Event('resize'));
  assert.equal(session.getState().zoom, 0.5);
  assert.equal(previewElement.style['--camera-image-width'], '50%');
  assert.equal(previewElement.style['--camera-image-height'], '50%');
  session.startRecording();
  assert.deepEqual(canvases[0].draws[0], [previewElement, 180, 320, 360, 640]);
  assert.deepEqual(canvases[0].fills[0], [0, 0, 720, 1280]);
  const closing = session.close();
  recorders[0].deliver();
  await closing;
});

test('device zoom is relative to its actual starting setting and rapid taps restore it', async () => {
  let actual = 2;
  const requested = [];
  const video = Object.assign(new Track('video'), {
    getCapabilities: () => ({ zoom: { min: 1, max: 3, step: 0.5 } }),
    getSettings: () => ({ zoom: actual }),
    async applyConstraints(c) {
      const zoom = c.advanced[0].zoom;
      requested.push(zoom);
      await Promise.resolve();
      actual = zoom;
    },
  });
  const { session, previewElement } = harness({ mediaDevices: { getUserMedia: async () => new Stream([new Track('audio'), video]) } });
  await session.enableCamera();
  previewElement.videoWidth = 720;
  previewElement.videoHeight = 1280;
  await session.setZoom(0.5);
  assert.equal(actual, 1);
  assert.equal(session.getState().zoomMode, 'device');
  assert.equal(previewElement.style['--camera-image-height'], '100%');
  await Promise.all([session.setZoom(1), session.setZoom(0.5), session.setZoom(1)]);
  assert.equal(session.getState().zoom, 1);
  assert.deepEqual(requested, [1, 2, 1, 2]);
  assert.equal(actual, 2);
  assert.equal(previewElement.style['--camera-image-height'], '100%');
  await session.close();
});

test('ignored device constraints fall back to framing while rejected PTZ permission still opens the camera', async () => {
  const calls = [];
  const applied = [];
  const video = Object.assign(new Track('video'), {
    getCapabilities: () => ({ zoom: { min: 1, max: 3, step: 1 } }),
    getSettings: () => ({ zoom: 2 }),
    async applyConstraints(constraints) { applied.push(constraints); },
  });
  const { session, previewElement } = harness({ mediaDevices: {
    getSupportedConstraints: () => ({ zoom: true }),
    async getUserMedia(c) {
      calls.push(c);
      if (c.video.zoom) throw new DOMException('No PTZ', 'NotAllowedError');
      return new Stream([new Track('audio'), video]);
    },
  } });
  await session.enableCamera();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].video.zoom, true);
  assert.deepEqual(calls[0].video.facingMode, { exact: 'user' });
  assert.equal(calls[1].video.zoom, undefined);
  assert.deepEqual(calls[1].video.facingMode, { ideal: 'user' });
  await session.setZoom(0.5);
  assert.equal(applied.length, 2);
  assert.equal(session.getState().zoomMode, 'digital');
  assert.equal(previewElement.style['--camera-image-height'], '50%');
  await session.setZoom(1);
  assert.equal(previewElement.style['--camera-image-height'], '100%');
  await session.close();
});

test('partial hardware widening is supplemented only by the remaining scale factor', async () => {
  let actual = 2;
  const video = Object.assign(new Track('video'), {
    getCapabilities: () => ({ zoom: { min: 1.5, max: 3, step: 0.5 } }),
    getSettings: () => ({ zoom: actual }),
    async applyConstraints({ advanced }) { actual = advanced[0].zoom; },
  });
  const { session, previewElement } = harness({
    mediaDevices: { getUserMedia: async () => new Stream([new Track('audio'), video]) },
  });
  await session.enableCamera();
  await session.setZoom(0.5);
  assert.equal(actual, 1.5);
  assert.equal(session.getState().zoomMode, 'digital');
  const renderFactor = parseFloat(previewElement.style['--camera-image-height']) / 100;
  assert.ok(Math.abs((actual / 2) * renderFactor - 0.5) < 1e-9);
  await session.setZoom(1);
  assert.equal(actual, 2);
  assert.equal(previewElement.style['--camera-image-height'], '100%');
  await session.close();
});

test('encoder setup and start failures release the compositor without stopping preview or mic', async () => {
  for (const Recorder of [class { constructor() { throw Error(); } }, class { start() { throw Error(); } }]) {
    const { session, canvases, frames } = harness({ Recorder });
    const stream = await session.enableCamera();
    assert.throws(() => session.startRecording(), /запись/);
    assert.equal(canvases[0].track.readyState, 'ended');
    assert.equal(frames.size, 0);
    assert.ok(stream.getTracks().every(track => track.readyState === 'live'));
    await session.close();
  }
});

test('temporary mute is visible, prevents a silent start, and does not break an active take', async () => {
  let state;
  const { session, recorders } = harness({ onChange: s => { state = s; } });
  const stream = await session.enableCamera();
  const [mic] = stream.getAudioTracks(), [video] = stream.getVideoTracks();
  mic.muted = true;
  mic.dispatchEvent(new Event('mute'));
  assert.equal(state.audioMuted, true);
  assert.throws(() => session.startRecording(), /звук/);
  assert.equal(recorders.length, 0);
  mic.muted = false;
  mic.dispatchEvent(new Event('unmute'));
  assert.equal(state.audioMuted, false);
  session.startRecording();
  recorders[0].onstart();
  video.muted = true;
  video.dispatchEvent(new Event('mute'));
  assert.equal(state.videoMuted, true);
  assert.equal(state.recording, 'recording');
  const end = session.close();
  recorders[0].deliver();
  await end;
});
