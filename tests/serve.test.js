import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createStaticServer } from '../scripts/serve.mjs';

async function withServer(run, { includeHiddenFiles = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'teleprompter-server-'));
  await writeFile(path.join(root, 'index.html'), '<!doctype html><title>Test shell</title>', 'utf8');
  await writeFile(path.join(root, 'app.js'), 'export const ready = true;', 'utf8');
  if (includeHiddenFiles) {
    await writeFile(path.join(root, '.env'), 'SECRET=test', 'utf8');
    await mkdir(path.join(root, '.git'));
    await writeFile(path.join(root, '.git', 'config'), '[core]', 'utf8');
  }

  const server = createStaticServer({ root });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

test('serves the app shell at the root with an HTML content type', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`);

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.match(await response.text(), /Test shell/);
  });
});

test('serves JavaScript assets with the correct content type', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/app.js`);

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/javascript/);
  });
});

test('falls back to the app shell only for HTML navigation', async () => {
  await withServer(async (baseUrl) => {
    const navigation = await fetch(`${baseUrl}/reader`, {
      headers: { accept: 'text/html' },
    });
    const missingAsset = await fetch(`${baseUrl}/missing.js`);

    assert.equal(navigation.status, 200);
    assert.match(await navigation.text(), /Test shell/);
    assert.equal(missingAsset.status, 404);
  });
});

test('does not serve files outside the configured root', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/..%2F..%2Fpackage.json`);

    assert.notEqual(response.status, 200);
  });
});

test('does not expose dotfiles or files inside hidden directories', async () => {
  await withServer(async (baseUrl) => {
    const root = new URL(baseUrl);
    const dotfile = await fetch(new URL('/.env', root));
    const gitConfig = await fetch(new URL('/.git/config', root));

    assert.equal(dotfile.status, 403);
    assert.equal(gitConfig.status, 403);
  }, { includeHiddenFiles: true });
});
