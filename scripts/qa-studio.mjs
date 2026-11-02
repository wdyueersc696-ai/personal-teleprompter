// Windows: set PLAYWRIGHT_MODULE to playwright-core/index.mjs and CHROME_PATH
// to chrome.exe, then run node scripts/qa-studio.mjs from the project root.
// Requires ffmpeg/ffprobe on PATH and a Russian Windows Desktop speech voice.
// Other systems can supply QA_SPEECH_WAV (48 kHz PCM) containing phrases below.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readdir, unlink, rmdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createStaticServer } from './serve.mjs';

const phrases = [
  'Сегодня утром я открыл окно и увидел как над городом медленно встаёт солнце',
  'На улице уже играли дети а по дороге проехал большой красный автобус',
];
const script = [...phrases, 'Позже мы пошли гулять в парк и долго смотрели на воду.',
  'Вечером мы вернулись домой и рассказали друзьям о нашей прогулке.'].join('\n\n');

function command(exe, args, options) {
  const r = spawnSync(exe, args, { windowsHide: true, encoding: 'utf8', ...options });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(exe + ' failed: ' + r.stderr);
  return r;
}

function speechFixture(dir) {
  if (process.env.QA_SPEECH_WAV) return path.resolve(process.env.QA_SPEECH_WAV);
  const synth = `
    $ErrorActionPreference = "Stop"
    Add-Type -AssemblyName System.Speech
    $voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
    try {
      $voice.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::NotSet,
        [System.Speech.Synthesis.VoiceAge]::NotSet, 0, [cultureinfo]"ru-RU")
      if ($voice.Voice.Culture.TwoLetterISOLanguageName -ne 'ru') { throw "A Russian voice is required" }
      $voice.SetOutputToWaveFile($env:QA_OUTPUT_WAV)
      $voice.Speak($env:QA_PHRASE)
    } finally { $voice.Dispose() }`;
  for (const [i, phrase] of phrases.entries()) {
    command('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(synth, 'utf16le').toString('base64')], {
      env: { ...process.env, QA_OUTPUT_WAV: path.join(dir, i + '.wav'), QA_PHRASE: phrase },
    });
  }
  const wav = path.join(dir, 'microphone.wav');
  command('ffmpeg', ['-v', 'error', '-i', path.join(dir, '0.wav'), '-i', path.join(dir, '1.wav'),
    '-filter_complex', '[0:a]adelay=6000,apad=pad_dur=6[a];[1:a]apad=pad_dur=8[b];[a][b]concat=n=2:v=0:a=1',
    '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
  return wav;
}

// A symmetric red target of known width survives selfie mirroring. Its size
// lets us compare the actual pixels in the viewfinder and the downloaded take.
function cameraFixture(dir) {
  const file = path.join(dir, 'camera.y4m');
  command('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=royalblue:s=1280x720:r=30',
    '-vf', 'drawbox=x=560:y=140:w=160:h=440:color=red:t=fill', '-frames:v', '4',
    '-pix_fmt', 'yuv420p', '-f', 'yuv4mpegpipe', file]);
  return file;
}

function targetWidths(input, png = false) {
  const width = 180;
  const args = png ? ['-i', 'pipe:0'] : ['-i', input];
  const rows = command('ffmpeg', ['-v', 'error', ...args, '-an',
    '-vf', (png ? '' : 'fps=6,') + 'scale=180:320,format=rgb24,crop=180:1:0:160',
    '-f', 'rawvideo', 'pipe:1'], { input: png ? input : undefined, encoding: null }).stdout;
  const sizes = [];
  for (let row = 0; row + width * 3 <= rows.length; row += width * 3) {
    let red = 0;
    for (let x = 0; x < width; x++) {
      const i = row + 3 * x;
      if (rows[i] > 160 && rows[i + 1] < 80 && rows[i + 2] < 80) red++;
    }
    sizes.push(red / width);
  }
  return sizes;
}

async function showTransport(page) {
  if (await page.locator('#reader-view').evaluate(el => el.classList.contains('controls-hidden'))) {
    await page.locator('#reader-scroll').tap({ position: { x: 28, y: 190 } });
  }
}

async function downloadTake(page, directory) {
  if (!await page.locator('#take-dialog').isVisible()) await page.locator('#reader-takes').click();
  await page.locator('#take-list').selectOption({ index: 0 });
  await page.waitForFunction(() => document.querySelector('#take-player').videoWidth > 0);
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#take-download').click()]);
  const file = path.join(directory, path.basename(download.suggestedFilename()));
  await download.saveAs(file);
  return file;
}

async function testZoom(page, dir) {
  const widths = [];
  await page.locator('#record-button').click();
  await page.locator('#record-indicator').waitFor({ state: 'visible' });
  for (const [zoom, expected] of [['wide', 160 / 1280], ['1', 160 / 405], ['2', 320 / 405]]) {
    const button = page.locator('#camera-zoom button[data-zoom="' + zoom + '"]');
    await button.click();
    await page.waitForFunction(z => document.querySelector('[data-zoom="' + z + '"]')?.getAttribute('aria-pressed') === 'true', zoom);
    await page.waitForTimeout(500);
    const shot = await page.locator('.camera-frame').screenshot();
    const [actual] = targetWidths(shot, true);
    assert.ok(Math.abs(actual - expected) < .035, 'viewfinder target width at ' + zoom + ': ' + actual);
    widths.push(actual);
  }
  await page.locator('#record-button').click();
  await page.locator('#record-indicator').waitFor({ state: 'hidden' });
  const file = await downloadTake(page, dir);
  const encoded = targetWidths(file);
  let from = 0;
  for (const actual of widths) {
    const i = encoded.findIndex((width, index) => index >= from && Math.abs(width - actual) < .035);
    assert.ok(i >= 0, 'downloaded frames lack the preview zoom of ' + actual);
    from = i + 1;
  }
  await page.locator('#take-close').click();
  return widths;
}

async function countCameraLines(page) {
  const results = [];
  for (const size of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(size);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const lines = await page.locator('#reader-scroll').evaluate(view => {
      const text = view.querySelector('article');
      return view.clientHeight / parseFloat(getComputedStyle(text).lineHeight);
    });
    assert.ok(lines >= (size.height >= 800 ? 6 : size.height >= 500 ? 4 : 2), 'too few lines in the camera prompt at ' + JSON.stringify(size) + ': ' + lines);
    for (const selector of ['#record-button', '#voice-toggle', '#camera-auto-toggle', '#camera-zoom']) {
      const rect = await page.locator(selector).boundingBox();
      assert.ok(rect && rect.x >= -1 && rect.y >= -1 && rect.x + rect.width <= size.width + 1
        && rect.y + rect.height <= size.height + 1, selector + ' outside ' + JSON.stringify(size));
    }
    results.push({ ...size, lines: Number(lines.toFixed(1)) });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  return results;
}

const dir = await mkdtemp(path.join(os.tmpdir(), 'teleprompter-studio-qa-'));
const server = createStaticServer({ root: process.cwd() });
let browser;
try {
  const wav = speechFixture(dir);
  const cameraFile = cameraFixture(dir);
  const pw = process.env.PLAYWRIGHT_MODULE ? pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright-core';
  const { chromium } = await import(pw);
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH,
    args: ['--use-fake-device-for-media-stream',
      '--use-file-for-fake-video-capture=' + cameraFile,
      '--use-file-for-fake-audio-capture=' + wav, '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    // Observe device/recorder track IDs without replacing audio or ASR output.
    window.captureAudit = { audioRequests: 0, audioIds: [], recordedAudio: [], began: 0, ended: 0, videoConstraints: null };
    const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async c => {
      // Some phones return landscape camera frames even in a portrait viewport.
      const stream = await get(c.video ? { ...c, video: { width: { exact: 1280 }, height: { exact: 720 } } } : c);
      // This input represents a fixed-focal-length camera. Exercise the
      // software fallback even if Chrome exposes synthetic zoom controls.
      for (const track of stream.getVideoTracks()) {
        const capabilities = track.getCapabilities();
        delete capabilities.zoom;
        track.getCapabilities = () => capabilities;
      }
      if (c.audio) window.captureAudit.audioRequests++;
      if (c.video) window.captureAudit.videoConstraints = c.video;
      window.captureAudit.audioIds.push(...stream.getAudioTracks().map(t => t.id));
      return stream;
    };
    const NativeRecorder = window.MediaRecorder;
    window.MediaRecorder = class extends NativeRecorder {
      constructor(stream, options) {
        super(stream, options);
        window.captureAudit.recordedAudio.push(...stream.getAudioTracks().map(t => t.id));
        this.addEventListener('start', () => window.captureAudit.began++);
        this.addEventListener('stop', () => window.captureAudit.ended++);
      }
    };
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const appUrl = process.env.QA_APP_URL || 'http://127.0.0.1:' + server.address().port;
  const { origin } = new URL(appUrl);
  await page.context().grantPermissions(['camera', 'microphone'], { origin });
  await page.goto(appUrl);
  await page.locator('#script-input').fill('');
  await page.locator('#shoot-button').click();
  await page.locator('#record-button:enabled').waitFor();
  assert.equal(await page.locator('#voice-toggle').isDisabled(), true);
  assert.equal(await page.locator('#camera-auto-toggle').isDisabled(), true);
  const zoomWidths = await testZoom(page, dir);
  await page.locator('#back-button').click();
  await page.locator('#script-input').fill(script);
  const speed = 100;
  await page.locator('#speed-input').evaluate((input, value) => {
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, speed);
  await page.locator('#shoot-button').click();
  const record = page.locator('#record-button'), voice = page.locator('#voice-toggle');
  const indicator = page.locator('#record-indicator'), status = page.locator('#studio-message');
  const scroll = page.locator('#reader-scroll');
  await page.waitForFunction(() => document.querySelector('#camera-preview')?.videoWidth > 0);
  const framing = await page.locator('#camera-preview').evaluate(video => {
    const rect = video.closest('.camera-frame').getBoundingClientRect();
    return { input: [video.videoWidth, video.videoHeight], previewRatio: rect.width / rect.height };
  });
  assert.deepEqual(framing.input, [1280, 720]);
  assert.ok(Math.abs(framing.previewRatio - 9 / 16) < 0.003, 'preview differs from the recorded crop');
  await page.locator('#prompt-toggle').click();
  assert.equal(await page.locator('#prompt-toggle').getAttribute('aria-pressed'), 'false');
  await page.locator('#prompt-toggle').click();
  if (process.env.QA_CAMERA_SCREENSHOT) await page.screenshot({ path: process.env.QA_CAMERA_SCREENSHOT });
  assert.equal(await voice.getAttribute('aria-checked'), 'false');
  // Camera entry starts a rehearsal at the saved WPM before recording.
  await page.waitForFunction(() => document.querySelector('#reader-scroll').scrollTop > 5);
  assert.equal(await page.locator('#camera-auto-toggle').getAttribute('aria-pressed'), 'true');
  await record.click();
  await indicator.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#reader-view').getAttribute('data-phase'), 'countdown');
  assert.ok(await scroll.evaluate(el => el.scrollTop < 2), 'take did not restart from the beginning');
  await page.waitForFunction(() => document.querySelector('#reader-view').dataset.phase === 'playing');
  const measured = await page.locator('#progress-input').evaluate(async input => {
    const start = performance.now(), progress = Number(input.value);
    await new Promise(resolve => setTimeout(resolve, 1000));
    return (Number(input.value) - progress) / 1000 / (performance.now() - start);
  });
  const measuredWpm = measured * script.split(/\s+/).length * 60000;
  assert.ok(Math.abs(measuredWpm - speed) < speed * .25, 'WPM while recording: ' + measuredWpm);
  page.once('dialog', dialog => dialog.dismiss());
  await showTransport(page);
  await page.locator('#back-button').click();
  assert.equal(await indicator.isVisible(), true, 'cancelled exit ended recording');
  assert.equal(await page.locator('#reader-view').isVisible(), true);
  await voice.click();
  await page.waitForFunction(() => document.querySelector('#voice-toggle').getAttribute('aria-checked') === 'true');
  const voiceStart = await scroll.evaluate(el => el.scrollTop);
  try {
    await page.waitForFunction(start => CSS.highlights.get('voice-word')?.size > 0
      && document.querySelector('#reader-scroll').scrollTop > start + 5, voiceStart, { timeout: 110000 });
  } catch (error) {
    throw new Error('Real speech did not move text: ' + await status.textContent(), { cause: error });
  }
  await page.waitForFunction(() => /пауза/i.test(document.querySelector('#studio-message').textContent), null, { timeout: 20000 });
  const paused = await scroll.evaluate(el => el.scrollTop);
  assert.ok(await page.evaluate(() => CSS.highlights.get('voice-word')?.size > 0), 'next word was not highlighted');
  await new Promise(resolve => setTimeout(resolve, 750));
  assert.ok(Math.abs(await scroll.evaluate(el => el.scrollTop) - paused) <= 2, 'text moves during a speech pause');
  const auto = page.locator('#camera-auto-toggle');
  await auto.click();  // Switch from voice directly to WPM during the same take.
  assert.equal(await voice.getAttribute('aria-checked'), 'false');
  assert.equal(await page.evaluate(() => CSS.highlights.has('voice-word')), false);
  await page.waitForFunction(y => document.querySelector('#reader-scroll').scrollTop > y + 5, paused);
  await voice.click();
  await page.waitForFunction(() => /слушаю|пауза/i.test(document.querySelector('#studio-message').textContent), null, { timeout: 60000 });
  assert.notEqual(await page.locator('#reader-view').getAttribute('data-phase'), 'playing');
  const manual = await scroll.evaluate(el => {
    el.scrollTop = (el.scrollHeight - el.clientHeight) * 0.72;
    return el.scrollTop;
  });
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.ok(Math.abs(await scroll.evaluate(el => el.scrollTop) - manual) < 4, 'manual position reset unexpectedly');
  await voice.click();  // WPM was active before voice, so turning voice off resumes it.
  assert.equal(await auto.getAttribute('aria-pressed'), 'true');
  await page.waitForFunction(y => document.querySelector('#reader-scroll').scrollTop > y + 5, manual);
  await auto.click();
  assert.equal(await auto.getAttribute('aria-pressed'), 'false');
  const stopped = await scroll.evaluate(el => el.scrollTop);
  await page.waitForTimeout(350);
  assert.ok(Math.abs(await scroll.evaluate(el => el.scrollTop) - stopped) <= 2, 'Темп failed to pause');
  assert.equal(await indicator.isVisible(), true);
  await record.click();
  await indicator.waitFor({ state: 'hidden' });
  const file = await downloadTake(page, dir);
  const probe = JSON.parse(command('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_type,codec_name,channels,width,height,avg_frame_rate:format=duration,size', '-of', 'json', file]).stdout);
  assert.deepEqual(probe.streams.map(x => x.codec_type).sort(), ['audio', 'video']);
  const video = probe.streams.find(x => x.codec_type === 'video');
  assert.deepEqual([video.width, video.height], [720, 1280], 'downloaded take must be portrait');
  const decoded = command('ffmpeg', ['-hide_banner', '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
  const maxVolume = Number(/max_volume:\s*(-?[\d.]+) dB/.exec(decoded.stderr)?.[1]);
  assert.ok(maxVolume > -60, 'saved recording has no audible signal');
  const timestamps = command('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file]).stdout.trim()
    .split(/\r?\n/).map(Number);
  assert.ok(timestamps.length > 10);
  const maxAudioInterval = Math.max(...timestamps.slice(1).map((t, i) => t - timestamps[i]));
  assert.ok(maxAudioInterval < 0.25, 'audible timeline has a gap during voice toggles');
  const audit = await page.evaluate(() => window.captureAudit);
  // One capture in the empty-camera check and one for the entire recorded take.
  assert.equal(audit.audioRequests, 2);
  assert.equal(audit.videoConstraints.width.ideal, 720);
  assert.equal(audit.videoConstraints.height.ideal, 1280);
  assert.equal(audit.began, 2);
  assert.equal(audit.ended, 2);
  assert.deepEqual(audit.recordedAudio, audit.audioIds);
  await page.locator('#take-close').click();
  await showTransport(page);
  await page.locator('#back-button').click();
  await page.locator('#setup-view').waitFor({ state: 'visible' });
  await page.reload();
  await page.locator('#setup-takes').click();
  await page.waitForFunction(() => document.querySelector('#take-player').videoWidth > 0);
  assert.equal(await page.locator('#take-list option').count(), 2, 'take missing after reload');
  await page.locator('#take-close').click();
  const refused = await browser.newContext();
  try {
    const p = await refused.newPage();
    const cdp = await refused.newCDPSession(p);
    const { targetInfo } = await cdp.send('Target.getTargetInfo');
    await cdp.send('Browser.setPermission', {
      origin, browserContextId: targetInfo.browserContextId,
      permission: { name: 'camera' }, setting: 'denied',
    });
    await p.goto(appUrl);
    await p.locator('#script-input').fill(script);
    await p.locator('#shoot-button').click();
    await p.waitForFunction(() => /разрешите/i.test(document.querySelector('#toast').textContent));
    assert.equal(await p.locator('#record-indicator').isVisible(), false);
    assert.equal(await p.locator('#record-button').isVisible(), false);
    await p.locator('#back-button').click();
    await p.locator('#setup-view').waitFor({ state: 'visible' });
  } finally { await refused.close(); }
  const offlineModel = await browser.newContext({ serviceWorkers: 'block' });
  try {
    await offlineModel.grantPermissions(['camera', 'microphone'], { origin });
    let blocked = 0;
    await offlineModel.route('**/vosk-model-small-ru-0.22.tar.gz*', r => { blocked++; return r.abort('failed'); });
    const p = await offlineModel.newPage();
    await p.goto(appUrl);
    await p.locator('#script-input').fill(script);
    await p.locator('#shoot-button').click();
    await p.locator('#record-button').click();
    await p.locator('#record-indicator').waitFor({ state: 'visible' });
    await p.locator('#voice-toggle').click();
    await p.waitForFunction(() => /для повтора/.test(document.querySelector('#studio-message').textContent), null, { timeout: 45000 });
    assert.ok(blocked > 0);
    assert.equal(await p.locator('#voice-toggle').getAttribute('aria-checked'), 'false');
    assert.equal(await p.locator('#record-indicator').isVisible(), true);
    await p.locator('#record-button').click();
    await p.locator('#reader-takes').click();
    await p.waitForFunction(() => document.querySelector('#take-player').videoWidth > 0);
  } finally { await offlineModel.close(); }
  await page.locator('#script-input').fill('Сегодня утром я открыл окно');
  await page.locator('#shoot-button').click();
  const viewports = await countCameraLines(page);
  await record.click();
  await indicator.waitFor({ state: 'visible' });
  await voice.click();
  await page.waitForFunction(() => /Сценарий прочитан/i.test(document.querySelector('#studio-message').textContent), null, { timeout: 65000 });
  assert.equal(await indicator.isVisible(), true);
  assert.equal(await voice.getAttribute('aria-checked'), 'false');
  await record.click();
  await indicator.waitFor({ state: 'hidden' });
  await showTransport(page);
  await page.locator('#back-button').click();
  await page.locator('#setup-view').waitFor({ state: 'visible' });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ browser: browser.version(), speech: 'synthetic Russian voice, real local Vosk',
    progressDuringPause: paused, manualPosition: manual, maxVolume, maxAudioInterval, probe, audioCaptures: audit.audioRequests,
    zoomWidths, viewports, measuredWpm, refusedPermission: true, cancelledExit: true, persistedAfterReload: true, timerMode: true,
    survivedAsrFailure: true, keptRecordingAtScriptEnd: true }, null, 2));
} finally {
  await browser?.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  for (const file of await readdir(dir)) await unlink(path.join(dir, file));
  await rmdir(dir);
}
