import test from 'node:test';
import assert from 'node:assert/strict';
import { createTakeLibrary, createTakeStore } from '../js/take-library.js';

class Control {
  events = {};
  value = '';
  open = false;
  hidden = true;
  children = [];
  addEventListener(name, fn) { this.events[name] = fn; }
  fire(name) { return this.events[name]?.(); }
  removeAttribute(name) { delete this[name]; }
  replaceChildren(...children) { this.children = children; }
  load() {}
  pause() {}
  showModal() { this.open = true; }
  close() { this.open = false; this.fire('close'); }
}

function harness(overrides = {}, extraHost = {}) {
  const nodes = new Map();
  const doc = {
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Control()); return nodes.get(id); },
    createElement() { return new Control(); },
  };
  const blobs = new Map();
  const meta = new Map();
  const released = [];
  const reads = [];
  const notices = [];
  let serial = 0;
  const host = {
    navigator: {},
    URL: { createObjectURL: () => 'blob:' + (++serial), revokeObjectURL: u => released.push(u) },
    crypto: { randomUUID: () => 'id' + (++serial) },
    confirm: () => true,
    ...extraHost,
  };
  const store = {
    async list() { return [...meta.values()]; },
    async read(id) { reads.push(id); return blobs.get(id); },
    async write(m, blob) { meta.set(m.id, m); blobs.set(m.id, blob); },
    async remove(id) { meta.delete(id); blobs.delete(id); },
    ...overrides,
  };
  const init = () => createTakeLibrary({ doc, host, store, notify: s => notices.push(s) });
  return { ui: init(), init, n: id => doc.getElementById(id), host, reads, released, notices, meta };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const video = () => new Blob(['video'], { type: 'video/mp4' });

test('durable takes restore metadata first, load one blob on selection and release URLs', async () => {
  const h = harness();
  await h.ui.restored;
  assert.equal(h.n('setup-takes').hidden, true);
  await h.ui.add(video());
  await h.ui.add(video());
  assert.equal(h.ui.hasUnsaved(), false);
  h.ui = h.init();
  await h.ui.restored;
  assert.equal(h.n('setup-takes').hidden, false);
  assert.deepEqual(h.reads, []);
  h.ui.open();
  await tick();
  assert.equal(h.reads.length, 1);
  const old = h.n('take-player').src;
  const list = h.n('take-list');
  list.value = list.children[1].value;
  await list.fire('change');
  assert.equal(h.reads.length, 2);
  assert.deepEqual(h.released, [old]);
  assert.match(h.n('take-download').download, /\.mp4$/);
  const latest = h.n('take-player').src;
  h.n('take-close').fire('click');
  assert.deepEqual(h.released, [old, latest]);
  assert.equal(h.n('take-download').hidden, true);
});

test('quota failure leaves a downloadable local copy until expressly deleted', async () => {
  const h = harness({ write: async () => { throw new Error('QuotaExceededError'); } });
  await h.ui.restored;
  assert.equal(await h.ui.add(video()), false);
  assert.equal(h.ui.hasUnsaved(), true);
  assert.match(h.notices[0], /только в памяти/);
  h.ui.open();
  assert.equal(h.n('take-download').hidden, false);
  h.host.confirm = () => false;
  await h.n('take-delete').fire('click');
  assert.equal(h.ui.hasUnsaved(), true);
  h.host.confirm = () => true;
  await h.n('take-delete').fire('click');
  assert.equal(h.ui.hasUnsaved(), false);
  assert.equal(h.n('take-download').hidden, true);
});

test('closing while blob read is pending never reattaches the player', async () => {
  let finish;
  const h = harness({ read: () => new Promise(r => { finish = r; }) });
  await h.ui.restored;
  await h.ui.add(video());
  h.ui.open();
  h.n('take-close').fire('click');
  finish(video());
  await tick();
  assert.equal(h.n('take-player').src, undefined);
  assert.equal(h.n('take-download').href, undefined);
});

test('failed shared-file export reports a fallback while user cancellation stays quiet', async () => {
  const h = harness({}, {
    File: class extends Blob { constructor(parts, name, options) { super(parts, options); this.name = name; } },
    navigator: { canShare: () => true, share: async () => { throw {name: 'AbortError'}; } },
  });
  await h.ui.restored;
  await h.ui.add(video());
  h.ui.open();
  await tick();
  assert.equal(h.n('take-share').hidden, false);
  const before = h.n('take-message').textContent;
  await h.n('take-share').fire('click');
  assert.equal(h.n('take-message').textContent, before);
  h.host.navigator.share = async () => { throw new Error('NotAllowedError'); };
  await h.n('take-share').fire('click');
  assert.match(h.n('take-message').textContent, /Скачать файл/);
});

test('store opening or blocked transactions have a bounded failure path', async () => {
  let lateRequest = {};
  const store = createTakeStore({ getIndexedDB: () => ({open: () => lateRequest}), timeout: 5 });
  await assert.rejects(store.list(), /истекло/);
  let closed = false;
  lateRequest.result = { close() { closed = true; } };
  lateRequest.onsuccess();
  assert.equal(closed, true);
  lateRequest = {};
  const read = store.read('1');
  let aborted = false;
  lateRequest.result = { transaction: () => ({
    objectStore: () => ({get: () => ({})}), abort() { aborted = true; },
  }) };
  lateRequest.onsuccess();
  await assert.rejects(read, /истекло/);
  assert.equal(aborted, true);
});
