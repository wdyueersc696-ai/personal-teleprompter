/* global self */
// Runs inside the dedicated recognition worker. Upstream IDBFS restores and
// persists the entire unpacked model. Only the compressed archive needs to
// survive a browser restart; the extracted files stay in WASM's memory FS.
(() => {
  const archiveSize = 46_211_681;
  const report = (state, detail = {}) => self.postMessage({ event: 'progress', state, detail });
  const failedDownload = 'Не удалось загрузить русскую модель. Проверьте интернет и включите голос ещё раз.';

  // A lazy stream reads from the already downloaded file, without cloning a
  // slow network response or allocating a second 46 MB buffer on the phone.
  async function cacheArchive(cache, url, fs, path, length) {
    const file = fs.open(path, 'r');
    let offset = 0;
    try {
      const body = new ReadableStream({
        pull(controller) {
          const chunk = new Uint8Array(Math.min(128 * 1024, length - offset));
          fs.read(file, chunk, 0, chunk.length, offset);
          offset += chunk.length;
          controller.enqueue(chunk);
          if (offset === length) controller.close();
        },
      });
      await cache.put(url, new Response(body, { headers: { 'Content-Length': String(length) } }));
    } finally {
      fs.close(file);
    }
  }

  self.loadTeleprompterModel = async (wasm, url) => {
    let cache, cached;
    try {
      cache = await self.caches.open('teleprompter-voice-models');
      cached = await cache.match(url);
    } catch { /* Storage can be unavailable or full. Recognition still works online. */ }
    const fs = wasm.FS;
    const dir = '/voice-model';
    const archive = dir + '/downloaded.tar.gz';
    fs.mkdir(dir);
    const isCached = Boolean(cached);
    const progress = loaded => report('downloading', { loaded, total: archiveSize, cached: isCached });
    progress(0);
    try {
      const response = cached || await fetch(url);
      if (!response.ok || !response.body) throw new Error(failedDownload);
      const reader = response.body.getReader();
      const file = fs.open(archive, 'w');
      let loaded = 0, reported = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (loaded + value.length > archiveSize) throw new Error(failedDownload);
          fs.write(file, value, 0, value.length);
          loaded += value.length;
          if (loaded - reported >= 256 * 1024 || loaded === archiveSize) {
            progress(loaded);
            reported = loaded;
          }
        }
      } finally {
        fs.close(file);
        reader.releaseLock();
      }
      if (loaded !== archiveSize) throw new Error(failedDownload);
    } catch {
      if (isCached) await cache.delete(url).catch(() => {});
      throw new Error(failedDownload);
    }
    report('initializing');
    // FS.open retains the file's contents while Vosk unlinks the archive
    // post-extraction. A slow/failed persistent write cannot block listening.
    const saving = !isCached && cache ? cacheArchive(cache, url, fs, archive, archiveSize).catch(error => {
      console.warn('Не удалось сохранить голосовую модель для работы офлайн:', error.message);
    }) : null;
    try {
      fs.close(fs.open(dir + '/downloaded.ok', 'w'));
      await wasm.downloadAndExtract(url, dir);
      const model = new wasm.Model(dir);
      if (saving) {
        // Let a normal cache write finish before the ready UI can be closed.
        // Private or slow storage must not hold up a working recognizer.
        let timeout;
        await Promise.race([saving, new Promise(resolve => { timeout = setTimeout(resolve, 1500); })]);
        clearTimeout(timeout);
      }
      return model;
    } catch {
      // Do not retain a corrupt (even if correctly sized) archive on retries.
      if (cache) await Promise.resolve(saving).then(() => cache.delete(url)).catch(() => {});
      throw new Error('Не удалось открыть русскую модель. Освободите память и включите голос ещё раз.');
    }
  };
})();
