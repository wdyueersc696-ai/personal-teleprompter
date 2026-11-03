import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverCameraLenses } from '../js/camera-lenses.js';
import { createCameraFraming } from '../js/camera-framing.js';

const camera = (deviceId, label, side) => ({
  kind: 'videoinput', deviceId, label, getCapabilities: () => side ? { facingMode: [side] } : {},
});
const discover = (devices, deviceId, facingMode) => discoverCameraLenses(
  { enumerateDevices: async () => devices },
  { getSettings: () => ({ deviceId, facingMode }) },
);

test('only a disclosed ultra-wide on the same side can widen the shot', async () => {
  const devices = [
    camera('selfie', 'Фронтальная камера'), camera('rear', 'Задняя камера'),
    camera('virtual', 'Back Dual Wide Camera (Wide + Ultra Wide)'), camera('ultra', 'Задняя сверхширокоугольная камера'),
  ];
  const front = await discover(devices, 'selfie', 'user');
  assert.equal(front.wideDeviceId, '');
  assert.equal(front.canFlip, true);
  const back = await discover(devices, 'rear', 'environment');
  assert.deepEqual([back.standardDeviceId, back.wideDeviceId, back.activePreset], ['rear', 'ultra', 1]);
  const wide = await discover(devices, 'ultra', 'environment');
  assert.deepEqual([wide.standardDeviceId, wide.wideDeviceId, wide.activePreset], ['rear', 'ultra', 0.5]);
});

test('the disclosed facing capability overrides a misleading name and opaque IDs cannot imply an ultra-wide lens', async () => {
  const devices = [camera('a', 'Back Camera'), camera('b', 'Camera 2'), camera('c', 'Front Ultra Wide', 'environment')];
  assert.equal((await discover(devices, 'a', 'environment')).wideDeviceId, 'c');
  assert.equal((await discover(devices.slice(0, 2), 'a', 'environment')).wideDeviceId, '');
});

test('missing enumeration leaves camera and an explicit facing switch usable', async () => {
  const track = { getSettings: () => ({ deviceId: 'rear', facingMode: 'environment' }) };
  const state = await discoverCameraLenses({ enumerateDevices() { throw Error(); } }, track);
  assert.equal(state.standardDeviceId, 'rear');
  assert.equal(state.wideDeviceId, '');
  assert.equal(state.canFlip, true);
});

test('an unsupported half zoom cannot shrink any portrait, square or landscape source in preview or recording', async () => {
  for (const [videoWidth, videoHeight] of [[1080, 1920], [1024, 1024], [1920, 1080]]) {
    const css = new Map();
    const source = { videoWidth, videoHeight, readyState: 2, style: { setProperty: (k, v) => css.set(k, v) } };
    const frame = createCameraFraming(source, () => {});
    frame.attach({ readyState: 'live' });
    await assert.rejects(frame.setZoom(0.5), /0,5/);
    assert.equal(frame.state().zoom, 1);
    // A separate physical lens already provides a wider image; draw it edge to edge.
    frame.attach({ readyState: 'live' }, 0.5);
    assert.equal(frame.state().zoom, 0.5);
    assert.ok([...css.values()].every(size => parseFloat(size) >= 100));
    let draw;
    frame.draw({ drawImage: (...args) => { draw = args; } }, 1080, 1920);
    const [, x, y, width, height] = draw;
    assert.ok(x <= 0 && y <= 0 && width >= 1080 && height >= 1920);
    assert.equal(width / height, videoWidth / videoHeight);
  }
});
