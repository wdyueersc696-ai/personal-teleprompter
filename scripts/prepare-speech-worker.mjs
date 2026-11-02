// Reproduce the mobile adapter from the unmodified, pinned upstream bundle.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const asset = name => new URL('../vendor/' + name, import.meta.url);
const original = await readFile(asset('vosk-0.0.8.js'));
if (createHash('sha256').update(original).digest('hex') !== '29504515526e974f4cb053cf08811c4de5fb2a74007c0a5a957db50eaa8d5d0c') {
  throw new Error('Unexpected vosk-browser build');
}
const source = original.toString('utf8');
const embedded = /var WorkerFactory = createBase64WorkerFactory\('([^']+)', null, false\);/.exec(source);
const worker = Buffer.from(embedded[1], 'base64').toString('utf8');
const start = worker.indexOf('        load(modelUrl) {');
const end = worker.indexOf('        allocateBuffer(', start);
if (start < 0 || end < 0) throw new Error('Unexpected recognizer worker layout');

// Keep the Kaldi/WASM implementation and its message protocol from upstream.
// Only replace the model loader and how the browser starts its worker.
const adapter = `        async load(modelUrl) {
            this.Vosk = await LoadVosk();
            this.Vosk.SetLogLevel(this.logger.getLogLevel());
            this.model = await self.loadTeleprompterModel(this.Vosk, modelUrl);
            return true;
        }
`;
const notice = '// Mobile adapter of vosk-browser 0.0.8. See vendor/SOURCES.md.\n';
const result = notice + "importScripts('../js/speech-model-cache.js');\n" + worker.slice(0, start) + adapter + worker.slice(end);
const facade = notice + source.replace(embedded[0], () =>
  "function WorkerFactory() { return new Worker(new URL('./vosk-worker-0.0.8-mobile.js', import.meta.url)); }");
await writeFile(asset('vosk-0.0.8-mobile.js'), facade);
await writeFile(asset('vosk-worker-0.0.8-mobile.js'), result);
