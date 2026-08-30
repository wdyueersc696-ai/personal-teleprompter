import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');

function variablesFrom(rule) {
  return Object.fromEntries(
    [...rule.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)]
      .map((match) => [match[1], match[2]]),
  );
}

function relativeLuminance(hex) {
  const channels = hex.slice(1).match(/../g).map((value) => Number.parseInt(value, 16) / 255);
  const [red, green, blue] = channels.map((value) => (
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
}

function contrast(first, second) {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  const brightest = Math.max(firstLuminance, secondLuminance);
  const darkest = Math.min(firstLuminance, secondLuminance);
  return (brightest + 0.05) / (darkest + 0.05);
}

test('countdown remains visible without intercepting reader controls', async () => {
  const css = await readFile(path.join(projectRoot, 'styles.css'), 'utf8');
  const countdownRule = css.match(/\.countdown-overlay\s*\{([^}]*)\}/)?.[1] ?? '';
  const controlsRule = css.match(/\.reader-controls\s*\{([^}]*)\}/)?.[1] ?? '';
  const countdownLayer = Number(countdownRule.match(/z-index:\s*(\d+)/)?.[1]);
  const controlsLayer = Number(controlsRule.match(/z-index:\s*(\d+)/)?.[1]);

  assert.match(countdownRule, /pointer-events:\s*none\s*;/);
  assert.ok(countdownLayer < controlsLayer, 'reader controls must stay visible above countdown');
});

test('only the phase label is a live region, not the per-frame clock', async () => {
  const html = await readFile(path.join(projectRoot, 'index.html'), 'utf8');
  const readerStatusTag = html.match(/<div class="reader-status"[^>]*>/)?.[0] ?? '';
  const phaseTag = html.match(/<span id="phase-label"[^>]*>/)?.[0] ?? '';
  const timeTag = html.match(/<span id="time-label"[^>]*>/)?.[0] ?? '';

  assert.doesNotMatch(readerStatusTag, /aria-live/);
  assert.match(phaseTag, /role="status"/);
  assert.match(phaseTag, /aria-live="polite"/);
  assert.doesNotMatch(timeTag, /aria-live/);
});

test('light theme accent remains visible as text, focus, and filled-button color', async () => {
  const css = await readFile(path.join(projectRoot, 'styles.css'), 'utf8');
  const rootRule = css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? '';
  const lightRule = css.match(/body\[data-theme="light"\]\s*\{([^}]*)\}/)?.[1] ?? '';
  const colors = { ...variablesFrom(rootRule), ...variablesFrom(lightRule) };

  assert.ok(contrast(colors.tally, colors.ink) >= 4.5, 'accent text on light page');
  assert.ok(contrast(colors.tally, colors.deck) >= 4.5, 'accent text on light panel');
  assert.ok(contrast(colors.tally, colors['deck-raised']) >= 3, 'focus outline on raised control');
  assert.ok(contrast(colors['tally-ink'], colors.tally) >= 4.5, 'filled-button label');
});

test('mobile controls keep 44px targets and quick settings in landscape', async () => {
  const css = await readFile(path.join(projectRoot, 'styles.css'), 'utf8');
  const segmentedRule = css.match(/(?:^|\n)\.segmented span\s*\{([^}]*)\}/)?.[1] ?? '';
  const quickButtonRule = css.match(/(?:^|\n)\.quick-step button\s*\{([^}]*)\}/)?.[1] ?? '';
  const landscapeTransportRule = css.match(
    /\.play-button,\s*\n\s*\.transport-button\s*\{([^}]*)\}/,
  )?.[1] ?? '';

  assert.ok(Number(segmentedRule.match(/min-height:\s*(\d+)px/)?.[1]) >= 44);
  assert.ok(Number(quickButtonRule.match(/min-height:\s*(\d+)px/)?.[1]) >= 44);
  assert.ok(Number(landscapeTransportRule.match(/min-height:\s*(\d+)px/)?.[1]) >= 44);
  assert.doesNotMatch(css, /\.quick-settings\s*\{\s*display:\s*none\s*;/);
});

test('script editor opts out of browser spellcheck services', async () => {
  const html = await readFile(path.join(projectRoot, 'index.html'), 'utf8');
  const textarea = html.match(/<textarea\s+[\s\S]*?id="script-input"[\s\S]*?>/)?.[0] ?? '';

  assert.match(textarea, /spellcheck="false"/);
  assert.match(textarea, /autocomplete="off"/);
});

test('fullscreen state listens for standard and prefixed WebKit events', async () => {
  const app = await readFile(path.join(projectRoot, 'js', 'app.js'), 'utf8');

  assert.match(app, /addEventListener\('fullscreenchange'/);
  assert.match(app, /addEventListener\('webkitfullscreenchange'/);
});

test('pending local changes are flushed on mobile lifecycle exits', async () => {
  const app = await readFile(path.join(projectRoot, 'js', 'app.js'), 'utf8');

  assert.match(app, /addEventListener\('pagehide', persistNow\)/);
  assert.match(app, /if \(document\.hidden\)[\s\S]{0,100}persistNow\(\)/);
});
