// Silk's fold field and light relief are adapted from React Bits (David Haz).
// Pointer highlights and the CSS button reveal are adapted from Magic UI.
// This is an application-specific native DOM/WebGL adaptation. See THIRD_PARTY_NOTICES.md.
const VERTEX = `
attribute vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;
const FRAGMENT = `
precision mediump float;
uniform vec2 resolution;
uniform float time;

float silk(vec2 uv) {
  float angle = -0.35;
  uv = mat2(cos(angle), -sin(angle), sin(angle), cos(angle)) * uv * 0.86;
  uv.y += 0.03 * sin(8.0 * uv.x - time);
  return 0.6 + 0.4 * sin(5.0 * (uv.x + uv.y + cos(3.0 * uv.x + 5.0 * uv.y)
    + 0.02 * time) + 0.65 * sin(20.0 * (uv.x + uv.y - 0.1 * time)));
}

void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  float pattern = silk(uv);
  vec2 stepSize = 1.0 / resolution;
  float gx = silk(uv + vec2(stepSize.x, 0.0)) - pattern;
  float gy = silk(uv + vec2(0.0, stepSize.y)) - pattern;
  vec3 normal = normalize(vec3(-gx * 22.0, -gy * 22.0, 1.0));
  vec3 light = normalize(vec3(-0.55, 0.7, 0.85));
  float relief = 1.0 + (dot(normal, light) - light.z) * 0.55;
  float fold = smoothstep(0.24, 0.93, pattern);
  float sheen = smoothstep(0.78, 1.0, pattern);
  vec3 color = mix(vec3(0.85, 0.50, 0.42), vec3(1.0, 0.86, 0.78), fold) * relief;
  color = mix(color, vec3(1.0, 0.97, 0.90), sheen * 0.68);
  gl_FragColor = vec4(color, 1.0);
}
`;

function createSilk(canvas) {
  const gl = canvas.getContext('webgl', {
    alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power',
  });
  if (!gl || gl.isContextLost()) return null;
  const shaders = [];
  const program = gl.createProgram();
  if (!program) return null;
  let buffer;
  function dispose() {
    shaders.forEach(shader => gl.deleteShader(shader));
    if (buffer) gl.deleteBuffer(buffer);
    if (program) gl.deleteProgram(program);
  }
  for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]]) {
    const shader = gl.createShader(type);
    if (!shader) { dispose(); return null; }
    shaders.push(shader);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { dispose(); return null; }
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { dispose(); return null; }
  gl.useProgram(program);
  buffer = gl.createBuffer();
  if (!buffer) { dispose(); return null; }
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'position');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const resolution = gl.getUniformLocation(program, 'resolution');
  const time = gl.getUniformLocation(program, 'time');
  return {
    draw(value) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(resolution, canvas.width, canvas.height);
      gl.uniform1f(time, value);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose,
  };
}

export function createHomeEffects({ root, storage }) {
  const canvas = root.querySelector('#silk-background');
  const toggle = root.querySelector('#background-toggle');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
  const storageKey = 'personal-teleprompter/background-motion-v1';
  let motion = true;
  try { motion = storage?.getItem(storageKey) !== 'off'; } catch { /* Optional preference. */ }
  let active = !root.hidden;
  let disposed = false;
  let failed = false;
  let gpu = null;
  let frame = null;
  let lastDraw = 0;
  let elapsed = 1.4;
  let spotFrame = null;
  let spotCard = null;
  let spotX = 0;
  let spotY = 0;

  const visible = () => active && !root.hidden && !document.hidden && !disposed;
  const animated = () => motion && !reduced.matches;
  function reflectState() {
    const running = visible() && animated() && !failed;
    root.dataset.backgroundState = failed ? 'fallback' : !visible() ? 'paused' : running ? 'running' : 'still';
    toggle.setAttribute('aria-pressed', String(animated() && !failed));
    toggle.disabled = reduced.matches || failed;
    toggle.title = failed ? 'Статичный фон' : reduced.matches ? 'В системе включено уменьшение движения'
      : motion ? 'Приостановить анимацию фона' : 'Включить анимацию фона';
  }
  function clearSpot() {
    cancelAnimationFrame(spotFrame);
    spotFrame = null;
    spotCard?.style.removeProperty('--spot-x');
    spotCard?.style.removeProperty('--spot-y');
    spotCard = null;
  }
  function stop() {
    cancelAnimationFrame(frame);
    frame = null;
    lastDraw = 0;
    clearSpot();
  }
  function draw(now) {
    frame = null;
    if (!visible() || failed) return;
    try {
      gpu ??= createSilk(canvas);
      if (!gpu) throw new Error('No background renderer');
      // Decorative motion is capped at 20 fps and 450k pixels on every device.
      if (!lastDraw || now - lastDraw >= 50 || !animated()) {
        if (lastDraw && animated()) elapsed += Math.min(0.1, (now - lastDraw) / 1000) * 0.55;
        gpu.draw(elapsed);
        lastDraw = now;
      }
      if (animated()) frame = requestAnimationFrame(draw);
    } catch {
      failed = true;
      gpu?.dispose();
      gpu = null;
      canvas.hidden = true;
      reflectState();
    }
  }
  function refresh() {
    stop();
    reflectState();
    if (!visible() || failed) return;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height) return;
    const ratio = Math.min(devicePixelRatio || 1, 1.25, Math.sqrt(450000 / (width * height)));
    const w = Math.max(1, Math.round(width * ratio)), h = Math.max(1, Math.round(height * ratio));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    frame = requestAnimationFrame(draw);
  }
  function moveSpot(event) {
    if (!visible() || reduced.matches || !finePointer.matches || event.pointerType === 'touch') return;
    const card = event.target.closest('[data-magic-card]');
    if (card !== spotCard) { clearSpot(); spotCard = card; }
    if (!card) return;
    const rect = card.getBoundingClientRect();
    spotX = event.clientX - rect.left;
    spotY = event.clientY - rect.top;
    if (spotFrame === null) spotFrame = requestAnimationFrame(() => {
      spotFrame = null;
      spotCard?.style.setProperty('--spot-x', spotX + 'px');
      spotCard?.style.setProperty('--spot-y', spotY + 'px');
    });
  }
  function toggleMotion() {
    motion = !motion;
    try { storage?.setItem(storageKey, motion ? 'on' : 'off'); } catch { /* Remain usable without storage. */ }
    refresh();
  }
  function contextLost(event) {
    event.preventDefault();
    stop();
    gpu = null;
    failed = true;
    canvas.hidden = true;
    reflectState();
  }
  function contextRestored() {
    failed = false;
    canvas.hidden = false;
    refresh();
  }
  const observer = globalThis.ResizeObserver ? new ResizeObserver(refresh) : null;
  if (observer) observer.observe(canvas.parentElement);
  else window.addEventListener('resize', refresh);
  root.addEventListener('pointermove', moveSpot, { passive: true });
  root.addEventListener('pointerleave', clearSpot);
  toggle.addEventListener('click', toggleMotion);
  reduced.addEventListener('change', refresh);
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('pagehide', stop);
  window.addEventListener('pageshow', refresh);
  canvas.addEventListener('webglcontextlost', contextLost);
  canvas.addEventListener('webglcontextrestored', contextRestored);
  refresh();
  return {
    setActive(value) { active = value; refresh(); },
    dispose() {
      disposed = true;
      stop();
      observer?.disconnect();
      window.removeEventListener('resize', refresh);
      root.removeEventListener('pointermove', moveSpot);
      root.removeEventListener('pointerleave', clearSpot);
      toggle.removeEventListener('click', toggleMotion);
      reduced.removeEventListener('change', refresh);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('pagehide', stop);
      window.removeEventListener('pageshow', refresh);
      canvas.removeEventListener('webglcontextlost', contextLost);
      canvas.removeEventListener('webglcontextrestored', contextRestored);
      gpu?.dispose();
    },
  };
}
