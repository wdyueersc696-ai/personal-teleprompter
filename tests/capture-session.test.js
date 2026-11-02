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
    Recorder, Stream, mediaDevices: {
      async getUserMedia(constraints) {
        calls.push(constraints);
        const kinds = ['audio', 'video'].filter(kind => constraints[kind]);
        return new Stream(kinds.map(kind => new Track(kind)));
      },
    },
    ...options,
  });
  return { session, calls, recorders, results, errors, tick: () => { time += 1234; } };
}

test('front camera and mic are acquired together; elapsed time starts on actual start event', async () => {
  const { session, calls, recorders, tick, results } = harness();
  const stream = await session.enableCamera();
  assert.deepEqual(calls.map(c => [c.audio, c.video.facingMode.ideal]), [[true, 'user']]);
  session.startRecording();
  const [rec] = recorders;
  assert.equal(rec.stream, stream);
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
  assert.deepEqual(calls[0].video, { facingMode: { ideal: 'user' }, width: { ideal: 720 }, height: { ideal: 1280 } });
  await session.close();
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
