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

  // Size the full source before the output clips its edges. Scaling an already
  // cropped 1× image would throw away peripheral pixels that fit at 0.5×.
  function imageSize() {
    const width = source?.videoWidth, height = source?.videoHeight;
    if (!width || !height) return null;
    const factor = Math.max(OUTPUT_WIDTH / width, OUTPUT_HEIGHT / height) * scale;
    return { width: width * factor, height: height * factor };
  }
  function state() {
    return { zoom, zoomMode: mode };
  }
  function sizePreview() {
    const size = imageSize();
    source?.style?.setProperty('--camera-image-width', size ? size.width / OUTPUT_WIDTH * 100 + '%' : '100%');
    source?.style?.setProperty('--camera-image-height', size ? size.height / OUTPUT_HEIGHT * 100 + '%' : '100%');
  }
  function apply(preset, nextMode, digitalScale) {
    zoom = preset;
    mode = nextMode;
    scale = digitalScale;
    sizePreview();
  }
  function attach(nextTrack) {
    track = nextTrack;
    device = deviceZoom(track);
    queue = Promise.resolve();
    apply(1, device ? 'device' : 'digital', 1);
  }
  function refresh() {
    if (!track) return;
    sizePreview();
    changed();
  }
  source?.addEventListener?.('loadedmetadata', refresh);
  source?.addEventListener?.('resize', refresh);

  async function change(selected, preset) {
    if (selected !== track || !track || track.readyState !== 'live') return;
    let factor = 1;
    if (device) {
      const { base, min, max, step } = device;
      const requested = base * preset;
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
      if (!Number.isFinite(factor) || factor <= 0) {
        throw new Error('Камера не сообщила применённый масштаб. Попробуйте ещё раз.');
      }
    }
    const digitalScale = preset / factor;
    apply(preset, device && Math.abs(digitalScale - 1) < 0.0001 ? 'device' : 'digital', digitalScale);
    changed();
  }
  function setZoom(value) {
    const preset = Number(value);
    if (![0.5, 1].includes(preset)) return Promise.reject(new Error('Неизвестный масштаб камеры.'));
    const selected = track;
    const result = queue.then(() => change(selected, preset));
    queue = result.catch(() => {});
    return result;
  }
  function draw(context) {
    const size = imageSize();
    if (source.readyState < 2 || !size) return;
    const { width, height } = size;
    if (width < OUTPUT_WIDTH || height < OUTPUT_HEIGHT) {
      context.fillStyle = '#101114';
      context.fillRect(0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);
    }
    context.drawImage(source, (OUTPUT_WIDTH - width) / 2, (OUTPUT_HEIGHT - height) / 2, width, height);
  }

  return { attach, state, setZoom, draw, width: OUTPUT_WIDTH, height: OUTPUT_HEIGHT };
}
