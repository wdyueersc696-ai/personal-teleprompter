import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

function ffmpeg(args, options) {
  return execFileSync('ffmpeg', ['-v', 'error', ...args], { windowsHide: true, ...options });
}

// Each of the 20 source frames has its white marker at a different x position.
// Counting marker changes catches a nominal 60 fps file made of duplicated 30 fps frames.
function movingChart(directory) {
  const file = path.join(directory, 'portrait-60.y4m');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=royalblue:s=1080x1920:r=60',
    '-f', 'lavfi', '-i', 'color=c=white:s=40x64:r=60', '-filter_complex',
    "[0][1]overlay=x='30+mod(n,20)*50':y=1100", '-frames:v', '20', '-pix_fmt', 'yuv420p',
    '-f', 'yuv4mpegpipe', file]);
  return file;
}

function analyzeTake(file, requested) {
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,codec_name:frame=best_effort_timestamp_time', '-of', 'json', file],
  { windowsHide: true, encoding: 'utf8' }));
  const video = probe.streams[0];
  assert.deepEqual([video.width, video.height], [1080, 1920]);
  const times = probe.frames.map(frame => Number(frame.best_effort_timestamp_time));
  const seconds = times.at(-1) - times[0];
  assert.ok(seconds >= 2, 'take too short to measure frame rate');
  // Timestamps were read from the original file. Give the raw pixel dump a
  // simple monotonic clock, keeping every decoded frame exactly once.
  const bytes = ffmpeg(['-i', file, '-an', '-vf',
    'scale=180:320,format=rgb24,crop=180:1:0:188,settb=1/1000,setpts=N*40',
    '-enc_time_base', '1:1000', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1']);
  const stride = 180 * 3;
  assert.equal(bytes.length / stride, times.length, 'probe disagrees with decoded frame count');
  let previous = -1;
  let changes = 0;
  for (let start = 0; start < bytes.length; start += stride) {
    let x = 0;
    while (x < 180 && (bytes[start + x * 3] < 200 || bytes[start + x * 3 + 1] < 200)) x++;
    assert.ok(x < 180, 'missing moving marker in saved video');
    if (previous !== -1 && Math.abs(previous - x) > 3) changes++;
    previous = x;
  }
  const encodedFps = (times.length - 1) / seconds;
  const distinctFps = changes / seconds;
  // Headless software encoding may drop frames under load. A 60 setting must
  // still capture substantially more distinct motion than a 30 fps stream.
  const minimum = requested === 60 ? 39 : 22;
  assert.ok(encodedFps > minimum && encodedFps <= requested * 1.12,
    'unexpected encoded cadence for ' + requested + ': ' + encodedFps);
  assert.ok(distinctFps > minimum, 'insufficient distinct frames at ' + requested + ': ' + distinctFps);
  return { requested, ...video, encodedFps: +encodedFps.toFixed(1), distinctFps: +distinctFps.toFixed(1) };
}

// Three simulated browser devices expose distinct images. A wider view can
// only reveal the green markers by opening the device with that exact ID.
function installVirtualLenses() {
  const devices = navigator.mediaDevices;
  const nativeGet = devices.getUserMedia.bind(devices);
  const names = { front: 'Front Camera', main: 'Back Camera', ultra: 'Back Ultra Wide Camera' };
  devices.enumerateDevices = async () => Object.entries(names).map(([deviceId, label]) => ({
    deviceId, label, kind: 'videoinput', groupId: 'test-cameras',
  }));
  devices.getUserMedia = async ({ video, audio }) => {
    const stream = audio ? await nativeGet({ audio }) : new MediaStream();
    if (!video) return stream;
    const facing = video.facingMode?.exact || video.facingMode?.ideal || 'user';
    const id = video.deviceId?.exact || (facing === 'user' ? 'front' : 'main');
    const canvas = document.createElement('canvas');
    canvas.width = 360; canvas.height = 640;
    const ctx = canvas.getContext('2d');
    const track = canvas.captureStream(30).getVideoTracks()[0];
    const paint = () => {
      ctx.fillStyle = 'royalblue'; ctx.fillRect(0, 0, 360, 640);
      const width = id === 'ultra' ? 72 : 144;
      ctx.fillStyle = 'red'; ctx.fillRect((360 - width) / 2, 100, width, 440);
      if (id === 'ultra') {
        ctx.fillStyle = 'lime'; ctx.fillRect(20, 100, 16, 440); ctx.fillRect(324, 100, 16, 440);
      }
    };
    paint();
    const timer = setInterval(paint, 1000 / 30);
    const stop = track.stop.bind(track);
    track.stop = () => { clearInterval(timer); stop(); };
    const settings = track.getSettings();
    track.getSettings = () => ({ ...settings, frameRate: 30, deviceId: id,
      facingMode: id === 'front' ? 'user' : 'environment' });
    Object.defineProperty(track, 'label', { value: names[id] });
    stream.addTrack(track);
    return stream;
  };
}

async function verifyLensSwitch(browser, appUrl, directory, downloadTake) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.context().grantPermissions(['camera', 'microphone'], { origin: new URL(appUrl).origin });
  await page.addInitScript(installVirtualLenses);
  await page.goto(appUrl);
  await page.locator('#script-input').fill('');
  await page.locator('#shoot-button').click();
  await page.locator('#record-button:enabled').waitFor();
  async function checkLens(id, zoom) {
    await page.waitForFunction(([deviceId, selection]) => {
      const v = document.querySelector('#camera-preview');
      return v.readyState >= 2 && v.srcObject?.getVideoTracks()[0]?.getSettings().deviceId === deviceId
        && document.querySelector('[data-zoom="' + selection + '"]').getAttribute('aria-pressed') === 'true';
    }, [id, zoom]);
  }
  await checkLens('front', '1');
  assert.ok(await page.locator('[data-zoom="0.5"]').isDisabled());
  await page.locator('#camera-options-toggle').click();
  await page.locator('#camera-fps').selectOption('60');
  await page.waitForFunction(() => document.querySelector('#camera-fps').value === '60' &&
    /до 30 кадр\/с.*60 кадр\/с недоступны/.test(document.querySelector('#capture-info').textContent));
  await page.locator('#camera-fps').selectOption('30');
  await page.locator('#camera-facing').selectOption('environment');
  await checkLens('main', '1');
  if (await page.locator('#camera-options-toggle').getAttribute('aria-expanded') === 'true') {
    await page.locator('#camera-options-toggle').click();
  }
  await page.locator('[data-zoom="0.5"]').click();
  await checkLens('ultra', '0.5');
  await page.locator('#record-button').click();
  await page.locator('#record-indicator').waitFor({ state: 'visible' });
  await page.waitForTimeout(1200);
  await page.locator('#record-button').click();
  await page.locator('#record-indicator').waitFor({ state: 'hidden' });
  const file = await downloadTake(page, directory);
  const width = 90;
  const frame = ffmpeg(['-ss', '0.5', '-i', file, '-frames:v', '1', '-an', '-vf',
    'scale=90:160,format=rgb24', '-f', 'rawvideo', 'pipe:1']);
  assert.equal(frame.length, width * 160 * 3);
  for (const [x, y, channel] of [[1, 1, 2], [88, 1, 2], [1, 158, 2], [88, 158, 2],
    [7, 80, 1], [83, 80, 1], [45, 80, 0]]) {
    const pos = 3 * (y * width + x);
    assert.ok(frame[pos + channel] > 170 && frame[pos + (channel + 1) % 3] < 140,
      'incorrect ultrawide picture at ' + [x, y]);
  }
  await page.locator('#take-close').click();
  await page.locator('[data-zoom="1"]').click();
  await checkLens('main', '1');
  await page.close();
  return 'front → rear main → rear ultra (recorded side markers and all four corners) → rear main';
}

export async function verifyCameraQuality({ chromium, directory, appUrl, downloadTake }) {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH,
    args: ['--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=' + movingChart(directory),
      '--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.context().grantPermissions(['camera', 'microphone'], { origin: new URL(appUrl).origin });
    await page.goto(appUrl);
    await page.locator('#script-input').fill('');
    await page.locator('#shoot-button').click();
    await page.locator('#record-button:enabled').waitFor();
    const results = [];
    for (const fps of [30, 60]) {
      await page.locator('#camera-options-toggle').click();
      await page.locator('#camera-fps').selectOption(String(fps));
      await page.waitForFunction(rate => {
        const preview = document.querySelector('#camera-preview');
        return preview.videoWidth === 1080 && preview.videoHeight === 1920
          && preview.srcObject?.getVideoTracks()[0]?.getSettings().frameRate === rate
          && document.querySelector('#capture-info').textContent.includes(String(rate));
      }, fps);
      if (await page.locator('#camera-options-toggle').getAttribute('aria-expanded') === 'true') {
        await page.locator('#camera-options-toggle').click();
      }
      await page.locator('#record-button').click();
      await page.locator('#record-indicator').waitFor({ state: 'visible' });
      await page.waitForTimeout(4200);
      await page.locator('#record-button').click();
      await page.locator('#record-indicator').waitFor({ state: 'hidden' });
      const file = await downloadTake(page, directory);
      const measured = analyzeTake(file, fps);
      if (file.toLowerCase().endsWith('.mp4')) {
        await page.waitForFunction(() => /кадр\/с/.test(document.querySelector('#take-properties').textContent));
        const properties = await page.locator('#take-properties').textContent();
        assert.ok(properties.includes('1080×1920'), 'library displays incorrect file dimensions');
        measured.libraryFps = Number(/([\d,]+) кадр\/с/.exec(properties)?.[1].replace(',', '.'));
        assert.ok(Math.abs(measured.libraryFps - measured.encodedFps) < 1.5,
          'library FPS disagrees with saved file: ' + properties + ' vs ' + measured.encodedFps);
      }
      results.push(measured);
      await page.locator('#take-close').click();
    }
    await page.close();
    return { recordings: results, virtualLenses: await verifyLensSwitch(browser, appUrl, directory, downloadTake) };
  } finally {
    await browser.close();
  }
}
