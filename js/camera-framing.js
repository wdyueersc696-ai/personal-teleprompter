const FRAME_WIDTH = 720;
const FRAME_HEIGHT = 1280;
const near = (a, b) => Math.abs(a - b) < 0.0001;

function hardwareRange(track) {
  try {
    const range = track?.getCapabilities?.().zoom;
    const base = track?.getSettings?.().zoom;
    if (!track?.applyConstraints || !range || !(base > 0) ||
        !(range.min > 0 && range.min <= base / 2 && base <= range.max)) return null;
    // A camera may expose zoom but only support integer steps (or only zoom in).
    const steps = (base / 2 - range.min) / range.step;
    if (range.step > 0 && !near(steps, Math.round(steps))) return null;
    return { base };
  } catch {
    return null;
  }
}

export function createCameraFraming(source, changed) {
  let track = null;
  let hardware = null;
  let zoom = 1;
  let queue = Promise.resolve();

  // The lens controls the field of view. Preview and export always cover 9:16.
  function imageSize(width, height) {
    if (!source?.videoWidth || !source.videoHeight) return null;
    const factor = Math.max(width / source.videoWidth, height / source.videoHeight);
    return { width: source.videoWidth * factor, height: source.videoHeight * factor };
  }
  function state() {
    return { zoom, zoomMode: 'device', hardwareWideAvailable: Boolean(hardware) };
  }
  function sizePreview() {
    const size = imageSize(FRAME_WIDTH, FRAME_HEIGHT);
    source?.style?.setProperty('--camera-image-width', size ? size.width / FRAME_WIDTH * 100 + '%' : '100%');
    source?.style?.setProperty('--camera-image-height', size ? size.height / FRAME_HEIGHT * 100 + '%' : '100%');
  }
  function attach(nextTrack, preset = 1) {
    track = nextTrack;
    zoom = preset;
    hardware = preset === 1 ? hardwareRange(track) : null;
    queue = Promise.resolve();
    sizePreview();
  }
  function refresh() {
    if (!track) return;
    sizePreview();
    changed();
  }
  source?.addEventListener?.('loadedmetadata', refresh);
  source?.addEventListener?.('resize', refresh);

  async function applyDeviceZoom(selected, target) {
    // Prefer preserving acquisition settings (in particular FPS). Some browsers
    // only process Image Capture constraints when sent independently.
    const { zoom: oldZoom, advanced = [], ...capture } = selected.getConstraints?.() ?? {};
    const keep = advanced.map(({ zoom, ...rest }) => rest).filter(item => Object.keys(item).length);
    const basicZoom = { zoom: { exact: target } };
    const requests = [];
    if (Object.keys(capture).length || keep.length) {
      requests.push({ ...capture, advanced: [...keep, { zoom: target }] },
        { ...capture, ...basicZoom, ...(keep.length ? { advanced: keep } : {}) });
    }
    requests.push({ advanced: [{ zoom: target }] }, basicZoom);
    for (const constraints of requests) {
      if (selected !== track || selected.readyState !== 'live') return false;
      if (near(selected.getSettings().zoom, target)) return true;
      try { await selected.applyConstraints(constraints); }
      catch { /* Try the next supported constraint form. */ }
    }
    return selected === track && near(selected.getSettings().zoom, target);
  }
  async function change(selected, preset) {
    if (selected !== track || !track || track.readyState !== 'live' || zoom === preset) return;
    if (!hardware) throw new Error('У этой камеры нет доступного режима 0,5× без полей.');
    const { base } = hardware;
    if (!await applyDeviceZoom(selected, base * preset)) {
      if (selected !== track || selected.readyState !== 'live') return;
      await applyDeviceZoom(selected, base * zoom);
      if (selected !== track) return;
      if (zoom === 1) hardware = null;
      changed();
      throw new Error('Камера не подтвердила переключение масштаба.');
    }
    zoom = preset;
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
  function draw(context, width = context.canvas?.width ?? FRAME_WIDTH, height = context.canvas?.height ?? FRAME_HEIGHT) {
    const size = imageSize(width, height);
    if (source.readyState < 2 || !size) return;
    context.drawImage(source, (width - size.width) / 2, (height - size.height) / 2, size.width, size.height);
  }

  return { attach, state, setZoom, draw, width: FRAME_WIDTH, height: FRAME_HEIGHT };
}
