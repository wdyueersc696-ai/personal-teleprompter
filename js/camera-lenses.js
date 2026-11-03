// Device labels are localized and are often hidden until camera access is
// granted. Never infer an ultra-wide lens from a device's index in the list.
function normalized(label = '') {
  return label.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[-‐‑–—]/g, ' ').trim();
}
function labelFacing(name) {
  if (/\b(front|user|selfie|frontal|facetime|truedepth|avant|vorderseite)\b|frontkamera|передн|фронтал|спереди|前置|前面/.test(name)) return 'user';
  if (/\b(back|rear|environment|arriere|trasera|posterior|ruckseite)\b|ruckkamera|задн|сзади|тылов|后置|後置|背面/.test(name)) return 'environment';
  return '';
}
function deviceFacing(device, name) {
  try {
    // InputDeviceInfo may include the facing mode even with a generic label.
    const modes = device.getCapabilities?.().facingMode;
    if (modes?.length === 1 && ['user', 'environment'].includes(modes[0])) return modes[0];
  } catch { /* Capability disclosure is optional. */ }
  return labelFacing(name);
}
function lensType(name) {
  if (/dual|tripl|двойн|троин|двух|телеобъектив|телекамер|telephoto|teleobjektiv/.test(name)) return 'other';
  if (/ultra\s*(?:wide|weitwinkel|grand\s*angle|gran\s*angular)|(?:сверх|ультра)\s*широк|超广角|超廣角|超広角|\b0[.,]5\s*[×xх]/.test(name)) return 'ultra';
  if (/wide\s*angle|широкоугол|\bmain\b|основная|^(?:(?:back|rear|front) camera|(?:задняя|передняя|фронтальная) камера|камера (?:сзади|спереди))$/.test(name)) return 'standard';
  return '';
}

export async function discoverCameraLenses(mediaDevices, track, preferredFacing = 'user') {
  const settings = track?.getSettings?.() ?? {};
  let devices = [];
  try { devices = await mediaDevices?.enumerateDevices?.() ?? []; }
  catch { /* Keep the active camera usable when the browser omits the list. */ }
  const cameras = devices.filter(d => d.kind === 'videoinput').map(device => {
    const name = normalized(device.label);
    return { id: device.deviceId, name, side: deviceFacing(device, name), type: lensType(name) };
  });
  const trackName = normalized(track?.label);
  const sameName = trackName ? cameras.filter(d => d.name === trackName) : [];
  const active = settings.deviceId ? cameras.find(d => d.id === settings.deviceId) : (sameName.length === 1 ? sameName[0] : null);
  const activeDeviceId = settings.deviceId || active?.id || '';
  const facingMode = settings.facingMode || active?.side || labelFacing(trackName) || preferredFacing;
  const activePreset = (active?.type || lensType(trackName)) === 'ultra' ? 0.5 : 1;
  const onSameSide = cameras.filter(d => d.id && d.side === facingMode);
  const wideDeviceId = activePreset === 0.5 ? activeDeviceId : (onSameSide.find(d => d.type === 'ultra')?.id ?? '');
  const standardDeviceId = activePreset === 1 ? activeDeviceId : (onSameSide.find(d => d.type === 'standard')?.id ?? '');
  const opposite = facingMode === 'user' ? 'environment' : 'user';
  // An exact facingMode request can also be tried when only the active camera
  // is disclosed. Multiple opaque IDs alone say nothing about their optics.
  const canFlip = cameras.some(d => d.side === opposite) || (Boolean(settings.facingMode) &&
    (cameras.length <= 1 || cameras.some(d => !d.side && d.id !== activeDeviceId)));
  return { facingMode, standardDeviceId, wideDeviceId, activeDeviceId, activePreset, canFlip };
}
