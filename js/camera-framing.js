const OUTPUT_WIDTH = 720;
const OUTPUT_HEIGHT = 1280;

// Browser-reported zoom units may use a device-specific origin. Treat the
// initial setting as our 1× and verify changes on the track before reporting them.
function deviceZoom(track) {
  try {
    const range = track?.getCapabilities?.().zoom;
    const base = track?.getSettings?.().zoom;
    if (!track?.applyConstraints || !range || !Number.isFinite(base) ||
        !(range.min > 0 && range.max > range.min && base >= range.min && base <= range.max)) return null;
    return { ...range, base };
  } catch {
    return null;
  }
}

export function createCameraFraming(source, changed) {
  let track = null;
  let device = null;
  let zoom = 1;
  let mode = 'digital';
  let scale = 1;
  let queue = Promise.resolve();

  function hasCroppedEdges() {
    if (!source?.videoWidth || !source.videoHeight) return false;
    const ratio = source.videoWidth / source.videoHeight;
    return Math.abs(ratio / (OUTPUT_WIDTH / OUTPUT_HEIGHT) - 1) > 0.01;
  }
  function state() {
    return { zoom, zoomMode: mode, canWiden: Boolean(track && (hasCroppedEdges() || (device && device.min < device.base))) };
  }
  function apply(preset, nextMode, digitalScale) {
    zoom = preset;
    mode = nextMode;
    scale = digitalScale;
    source?.style?.setProperty('--camera-fit', mode === 'fit' ? 'contain' : 'cover');
    source?.style?.setProperty('--camera-scale', String(scale));
  }
  function attach(nextTrack) {
    track = nextTrack;
    device = deviceZoom(track);
    queue = Promise.resolve();
    apply(1, device ? 'device' : 'digital', 1);
  }
  function refresh() {
    if (!track) return;
    if (zoom === 'wide' && !state().canWiden) apply(1, 'digital', 1);
    changed();
  }
  source?.addEventListener?.('loadedmetadata', refresh);
  source?.addEventListener?.('resize', refresh);

  async function change(selected, preset) {
    if (selected !== track || !track || track.readyState !== 'live') return;
    const wide = preset === 'wide';
    if (wide && !state().canWiden) throw new Error('Камера уже показывает весь доступный кадр.');
    let factor = 1;
    if (device) {
      const { base, min, max, step } = device;
      const requested = wide ? min : base * preset;
      let target = Math.min(max, Math.max(min, requested));
      if (step > 0 && target !== max && target !== base) {
        target = min + Math.floor((target - min) / step + 1e-6) * step;
      }
      // Some implementations use the advanced Image Capture constraint, some
      // the basic form. Do not mix it with acquisition (width/height) constraints.
      for (const constraints of [{ advanced: [{ zoom: target }] }, { zoom: { exact: target } }]) {
        if (selected !== track || track.readyState !== 'live') return;
        if (Math.abs(target - track.getSettings().zoom) < 1e-6) break;
        try { await track.applyConstraints(constraints); }
        catch { /* Try the other form, then use the actual reported setting. */ }
      }
      if (selected !== track || track.readyState !== 'live') return;
      factor = track.getSettings().zoom / base;
      if (!Number.isFinite(factor) || factor <= 0 || factor > (wide ? 1 : preset) + 1e-4) {
        throw new Error('Камера не применила выбранный масштаб. Попробуйте ещё раз.');
      }
    }
    if (wide && factor >= 1 && !hasCroppedEdges()) {
      throw new Error('Камера не предоставила более широкий угол.');
    }
    const fit = wide && factor >= 1;
    const digitalScale = wide ? 1 : Math.max(1, preset / factor);
    apply(preset, fit ? 'fit' : device && digitalScale < 1.0001 ? 'device' : 'digital', digitalScale);
    changed();
  }
  function setZoom(value) {
    const preset = value === 'wide' ? value : Number(value);
    if (!['wide', 1, 1.5, 2].includes(preset)) return Promise.reject(new Error('Неизвестный масштаб камеры.'));
    const selected = track;
    const result = queue.then(() => change(selected, preset));
    queue = result.catch(() => {});
    return result;
  }
  function draw(context) {
    const { videoWidth: width, videoHeight: height } = source;
    if (source.readyState < 2 || !width || !height) return;
    if (mode === 'fit') {
      const fit = Math.min(OUTPUT_WIDTH / width, OUTPUT_HEIGHT / height);
      const w = width * fit, h = height * fit;
      context.fillStyle = '#101114';
      context.fillRect(0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);
      context.drawImage(source, (OUTPUT_WIDTH - w) / 2, (OUTPUT_HEIGHT - h) / 2, w, h);
      return;
    }
    const cover = Math.max(OUTPUT_WIDTH / width, OUTPUT_HEIGHT / height) * scale;
    const w = OUTPUT_WIDTH / cover, h = OUTPUT_HEIGHT / cover;
    context.drawImage(source, (width - w) / 2, (height - h) / 2, w, h, 0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);
  }

  return { attach, state, setZoom, draw, width: OUTPUT_WIDTH, height: OUTPUT_HEIGHT };
}
