const DB_NAME = 'teleprompter-recordings-v1';
const META = 'metadata';
const MEDIA = 'media';
const MEMORY_WARNING = 'Дубль сейчас только в памяти. Сохраните файл до закрытия страницы.';

// Media and list entries are separate so opening the list never reads all videos.
export function createTakeStore({ getIndexedDB = () => globalThis.indexedDB, timeout = 20_000 } = {}) {
  let connection;
  function connect() {
    if (connection) return connection;
    connection = new Promise((resolve, reject) => {
      const request = getIndexedDB().open(DB_NAME, 1);
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        reject(new Error('Ожидание локального хранилища истекло'));
      }, timeout);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(META, { keyPath: 'id' });
        request.result.createObjectStore(MEDIA);
      };
      request.onsuccess = () => {
        clearTimeout(timer);
        const db = request.result;
        if (expired) return db.close();
        db.onversionchange = () => { db.close(); connection = undefined; };
        resolve(db);
      };
      request.onerror = () => { clearTimeout(timer); reject(request.error); };
    }).catch(error => { connection = undefined; throw error; });
    return connection;
  }
  async function transact(stores, mode, action) {
    const db = await connect();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      const timer = setTimeout(() => {
        try { tx.abort(); } catch { /* already committing */ }
        reject(new Error('Ожидание операции с дублем истекло'));
      }, timeout);
      let result;
      tx.oncomplete = () => { clearTimeout(timer); resolve(result?.result); };
      tx.onabort = () => { clearTimeout(timer); reject(tx.error ?? new Error('Операция прервана')); };
      try {
        result = action(tx);
      } catch (error) {
        clearTimeout(timer);
        tx.abort();
        reject(error);
      }
    });
  }
  return {
    list: () => transact([META], 'readonly', tx => tx.objectStore(META).getAll()),
    read: id => transact([MEDIA], 'readonly', tx => tx.objectStore(MEDIA).get(id)),
    write: (meta, blob) => transact([META, MEDIA], 'readwrite', tx => {
      tx.objectStore(META).put(meta);
      tx.objectStore(MEDIA).put(blob, meta.id);
    }),
    remove: id => transact([META, MEDIA], 'readwrite', tx => {
      tx.objectStore(META).delete(id);
      tx.objectStore(MEDIA).delete(id);
    }),
  };
}

export function createTakeLibrary({
  notify = () => {}, onOpen, store = createTakeStore(),
  doc = document, host = window,
} = {}) {
  const byId = id => doc.getElementById(id);
  const launchers = [byId('setup-takes'), byId('reader-takes')];
  const dialog = byId('take-dialog');
  const list = byId('take-list');
  const player = byId('take-player');
  const download = byId('take-download');
  const share = byId('take-share');
  const remove = byId('take-delete');
  const message = byId('take-message');
  const entries = new Map();
  const volatile = new Map();
  const writing = new Map();
  let url = null;
  let file = null;
  let selection = 0;
  let listError = false;

  function showLaunchers() {
    launchers.forEach(button => { button.hidden = entries.size === 0; });
  }
  function releasePlayer() {
    selection++;
    player.pause();
    player.removeAttribute('src');
    player.load();
    download.removeAttribute('href');
    download.hidden = true;
    share.hidden = true;
    file = null;
    if (url) host.URL.revokeObjectURL(url);
    url = null;
  }
  async function selectTake() {
    releasePlayer();
    const revision = selection;
    const meta = entries.get(list.value);
    remove.disabled = !meta;
    if (!meta) {
      message.textContent = listError ? 'Список сохранённых дублей недоступен.' : 'Пока нет дублей.';
      return;
    }
    message.textContent = 'Открываем дубль…';
    try {
      const blob = volatile.get(meta.id) ?? await store.read(meta.id);
      if (selection !== revision || !dialog.open) return;
      if (!blob?.size) throw new Error('Пустой файл');
      url = host.URL.createObjectURL(blob);
      player.src = url;
      download.href = url;
      download.download = meta.name;
      download.hidden = false;
      message.textContent = volatile.has(meta.id) ? MEMORY_WARNING : 'Дубль сохранён в этом браузере.';
      if (host.File && host.navigator.share && host.navigator.canShare) {
        try {
          file = new host.File([blob], meta.name, { type: blob.type });
          share.hidden = !host.navigator.canShare({ files: [file] });
        } catch { share.hidden = true; }
      }
    } catch {
      if (selection === revision) message.textContent = 'Не удалось открыть этот дубль. Выберите его повторно.';
    }
  }
  function refreshList(preferred = list.value) {
    showLaunchers();
    if (!dialog.open) return;
    const ordered = [...entries.values()].sort((a, b) => b.time - a.time);
    list.replaceChildren(...ordered.map(meta => {
      const option = doc.createElement('option');
      option.value = meta.id;
      option.textContent = new Date(meta.time).toLocaleString('ru-RU') + ' · '
        + (meta.bytes / (1024 * 1024)).toFixed(1) + ' МБ';
      return option;
    }));
    list.value = entries.has(preferred) ? preferred : ordered[0]?.id ?? '';
    void selectTake();
  }
  const restored = store.list().then(saved => {
    for (const meta of saved) entries.set(meta.id, meta);
    refreshList();
  }).catch(() => { listError = true; });

  function add(blob) {
    if (!blob?.size) {
      notify('Запись пуста, сохранить дубль не удалось.');
      return Promise.resolve(false);
    }
    const time = Date.now();
    const id = host.crypto?.randomUUID?.() ?? time.toString(36) + '-' + Math.random().toString(36).slice(2);
    const ext = /mp4/i.test(blob.type) ? 'mp4' : /quicktime/i.test(blob.type) ? 'mov'
      : /matroska/i.test(blob.type) ? 'mkv' : 'webm';
    const meta = {
      id, time, bytes: blob.size,
      name: 'Дубль-' + new Date(time).toISOString().replace(/[:.]/g, '-') + '.' + ext,
    };
    entries.set(id, meta);
    volatile.set(id, blob);
    refreshList(id);
    const pending = store.write(meta, blob).then(() => {
      volatile.delete(id);
      if (dialog.open && list.value === id) message.textContent = 'Дубль сохранён в этом браузере.';
      return true;
    }).catch(() => {
      if (dialog.open && list.value === id) message.textContent = MEMORY_WARNING;
      notify(MEMORY_WARNING);
      return false;
    }).finally(() => writing.delete(id));
    writing.set(id, pending);
    return pending;
  }

  function open() {
    if (dialog.open || onOpen?.() === false) return;
    if (dialog.showModal) dialog.showModal();
    else dialog.setAttribute('open', '');
    refreshList();
  }
  function close() {
    if (dialog.close) dialog.close();
    else { dialog.removeAttribute('open'); releasePlayer(); }
  }
  dialog.addEventListener('close', releasePlayer);
  byId('take-close').addEventListener('click', close);
  launchers.forEach(button => button.addEventListener('click', open));
  list.addEventListener('change', selectTake);
  player.addEventListener('error', () => {
    if (dialog.open && url && player.error) {
      message.textContent = 'Этот браузер не воспроизвёл видео. Скачайте файл и откройте его в проигрывателе.';
    }
  });
  download.addEventListener('click', () => {
    if (url) message.textContent = 'Проверьте сохранение файла в загрузках устройства.';
  });
  share.addEventListener('click', async () => {
    if (!file) return;
    const revision = selection;
    try {
      await host.navigator.share({ files: [file] });
    } catch (error) {
      if (selection === revision && error?.name !== 'AbortError') {
        message.textContent = 'Не удалось отправить дубль. Воспользуйтесь кнопкой «Скачать файл».';
      }
    }
  });
  remove.addEventListener('click', async () => {
    const id = list.value;
    if (!entries.has(id) || !host.confirm('Удалить выбранный дубль из этого браузера?')) return;
    remove.disabled = true;
    try {
      await writing.get(id);
      if (!volatile.has(id)) await store.remove(id);
      entries.delete(id);
      volatile.delete(id);
      refreshList();
    } catch {
      if (dialog.open && list.value === id) {
        message.textContent = 'Удаление не удалось. Попробуйте ещё раз.';
        remove.disabled = false;
      }
    }
  });
  return { add, open, isOpen: () => Boolean(dialog.open), hasUnsaved: () => volatile.size > 0, restored };
}
