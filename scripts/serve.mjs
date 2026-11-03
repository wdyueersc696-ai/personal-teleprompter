import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.woff2', 'font/woff2'],
]);

function contentType(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? 'application/octet-stream';
}

function isInsideRoot(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function existingFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

export function createStaticServer({ root }) {
  const absoluteRoot = path.resolve(root);

  return createServer(async (request, response) => {
    if (!['GET', 'HEAD'].includes(request.method ?? 'GET')) {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }

    let decodedPath;
    try {
      decodedPath = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    } catch {
      response.writeHead(400);
      response.end('Bad request');
      return;
    }

    const containsHiddenSegment = decodedPath
      .split(/[\\/]+/u)
      .some((segment) => segment.startsWith('.'));
    if (containsHiddenSegment) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }

    const relativePath = decodedPath === '/' ? 'index.html' : `.${decodedPath}`;
    let filePath = path.resolve(absoluteRoot, relativePath);

    if (!isInsideRoot(absoluteRoot, filePath)) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }

    if (!(await existingFile(filePath))) {
      const acceptsHtml = request.headers.accept?.includes('text/html');
      if (!acceptsHtml) {
        response.writeHead(404);
        response.end('Not found');
        return;
      }
      filePath = path.join(absoluteRoot, 'index.html');
    }

    try {
      const body = await readFile(filePath);
      response.writeHead(200, {
        'Content-Type': contentType(filePath),
        'Cache-Control': 'no-store',
        'Content-Length': body.byteLength,
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
      response.writeHead(404);
      response.end('Not found');
    }
  });
}

function argumentValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const launchedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (launchedDirectly) {
  const port = Number(argumentValue('--port', process.env.PORT ?? 4173));
  const host = argumentValue('--host', process.env.HOST ?? '127.0.0.1');
  const root = path.resolve(argumentValue('--root', process.cwd()));
  const server = createStaticServer({ root });

  server.listen(port, host, () => {
    const visibleHost = host === '0.0.0.0' ? 'localhost' : host;
    process.stdout.write(`ReadReel: http://${visibleHost}:${port}\n`);
  });
}
