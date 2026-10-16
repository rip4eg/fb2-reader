// Хранилище: библиотека книг + прогресс чтения.
// Два режима с одинаковым интерфейсом: GitHub-репозиторий и локальный (IndexedDB).

import { GitHubApi, GhError } from './gh.js';
import { idb, normSpace, utf8ToB64, bytesToB64 } from './util.js';
import { device, setDeviceName } from './config.js';

const LIB_PATH = 'library.json';

const emptyLibrary = () => ({ version: 1, updatedAt: new Date().toISOString(), books: [] });

const extOf = (type) =>
  type === 'image/png' ? 'png' :
  type === 'image/gif' ? 'gif' :
  type === 'image/webp' ? 'webp' :
  type === 'image/svg+xml' ? 'svg' : 'jpg';

// ------------------------------------------------------------------ backend

class GithubBackend {
  constructor(cfg) {
    this.api = new GitHubApi(cfg);
    this.tree = new Map();
    this.kind = 'github';
  }

  async init() {
    await this.api.whoami();
    const { repo, branch } = await this.api.connect();
    this.repoInfo = repo;
    this.branch = branch;
    return { repo, branch };
  }

  async refresh() {
    const { tree } = await this.api.getTree();
    this.tree = new Map(tree.filter((t) => t.type === 'blob').map((t) => [t.path, t]));
    return this.tree;
  }

  has(path) { return this.tree.has(path); }
  shaOf(path) { const e = this.tree.get(path); return e ? e.sha : null; }
  listPaths(prefix) { return Array.from(this.tree.keys()).filter((p) => p.startsWith(prefix)); }

  async getBytes(path, { cache = true } = {}) {
    const entry = this.tree.get(path);
    if (!entry) return null;
    const key = 'sha:' + entry.sha;
    if (cache) {
      const hit = await idb.get(key).catch(() => null);
      if (hit) return hit;
    }
    const bytes = await this.api.getBlobBytes(entry.sha);
    if (cache) idb.put(key, bytes.buffer.slice(0)).catch(() => {});
    return bytes.buffer.slice(0);
  }

  async getText(path) {
    const bytes = await this.getBytes(path);
    if (!bytes) return null;
    return new TextDecoder().decode(new Uint8Array(bytes));
  }

  async putText(path, text, message) {
    return await this.api.putFileText(path, text, message || 'Обновление данных читалки');
  }

  async commitFiles(files, message) {
    const prepared = files.map((f) => {
      if (f.remove) return { path: f.path, remove: true };
      if (typeof f.text === 'string') return { path: f.path, base64: utf8ToB64(f.text) };
      const u8 = f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes);
      return { path: f.path, base64: bytesToB64(u8) };
    });
    return await this.api.commitFiles(prepared, message);
  }
}

class LocalBackend {
  constructor() { this.kind = 'local'; this.paths = new Set(); }

  async init() { return { repo: null, branch: null }; }

  async refresh() {
    const keys = await idb.keys('files');
    this.paths = new Set(keys.filter((k) => !String(k).startsWith('sha:')));
    return this.paths;
  }

  has(path) { return this.paths.has(path); }
  shaOf(path) { return this.paths.has(path) ? 'local' : null; }
  listPaths(prefix) { return Array.from(this.paths).filter((p) => p.startsWith(prefix)); }

  async getBytes(path) {
    const v = await idb.get(path);
    if (v == null) return null;
    if (v instanceof ArrayBuffer) return v;
    if (v && v.__blob) return v.__blob;
    return null;
  }

  async getText(path) {
    const v = await idb.get(path);
    return typeof v === 'string' ? v : null;
  }

  async putText(path, text) {
    await idb.put(path, text);
    this.paths.add(path);
  }

  async commitFiles(files) {
    for (const f of files) {
      if (f.remove) { await idb.del(f.path); this.paths.delete(f.path); continue; }
      if (typeof f.text === 'string') await idb.put(f.path, f.text);
      else {
        const u8 = f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes);
        await idb.put(f.path, u8.buffer.slice(0, u8.byteLength));
      }
      this.paths.add(f.path);
    }
    return null;
  }
}

// ------------------------------------------------------------------- store

export class Store extends EventTarget {
  constructor() {
    super();
    this.cfg = null;
    this.backend = null;
    this.library = emptyLibrary();
    this.remote = new Map();     // deviceId -> файл прогресса
    this.me = null;              // мой файл прогресса
    this.status = 'idle';
    this.error = null;
    this.offline = false;
    this.lastSyncAt = 0;
    this.pushTimer = null;
    this.pushDelayMs = 12000; // как часто позиция уходит в репозиторий при непрерывном чтении
    this._pushing = null;
    this._queued = false;
    this.dirty = false;
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  setStatus(status, error = null) {
    this.status = status;
    this.error = error;
    if (status === 'ok') this.lastSyncAt = Date.now();
    this.emit('status', { status, error });
  }

  get device() { return device(); }

  async connect(cfg) {
    this.cfg = cfg;
    if (!cfg || cfg.mode === 'local') this.backend = new LocalBackend();
    else this.backend = new GithubBackend(cfg);
    return await this.backend.init();
  }

  // ---------------------------------------------------------- чтение данных

  async refresh() {
    this.setStatus('busy');
    try {
      // сначала отдаём несохранённую позицию, чтобы не потерять её при чтении
      if (this.dirty) { try { await this.flushProgress(); } catch { /* попробуем позже */ } }
      await this.backend.refresh();
      this.offline = false;

      if (!this.backend.has(LIB_PATH)) {
        if (this.backend.kind === 'github') {
          await this.backend.commitFiles([{ path: LIB_PATH, text: JSON.stringify(emptyLibrary(), null, 1) }], 'Инициализация библиотеки');
          await this.backend.refresh();
        } else {
          await this.backend.putText(LIB_PATH, JSON.stringify(emptyLibrary(), null, 1));
          await this.backend.refresh();
        }
      }

      const raw = await this.backend.getText(LIB_PATH);
      const lib = raw ? JSON.parse(raw) : emptyLibrary();
      if (!Array.isArray(lib.books)) lib.books = [];
      this.library = lib;

      const paths = this.backend.listPaths('progress/').filter((p) => p.endsWith('.json'));
      this.remote = new Map();
      for (const p of paths) {
        const text = await this.backend.getText(p);
        if (!text) continue;
        try {
          const obj = JSON.parse(text);
          const id = obj.deviceId || p.replace(/^progress\//, '').replace(/\.json$/, '');
          obj.deviceId = id;
          if (!obj.books) obj.books = {};
          this.remote.set(id, obj);
        } catch { /* битый файл прогресса игнорируем */ }
      }

      const did = this.device.id;
      if (!this.remote.has(did)) {
        this.remote.set(did, { deviceId: did, deviceName: this.device.name, updatedAt: new Date().toISOString(), books: {} });
      }
      const fetched = this.remote.get(did);
      if (!fetched.books) fetched.books = {};
      // Не теряем записи, сделанные во время сетевых запросов: файл из репозитория
      // может оказаться старее того, что уже лежит в памяти.
      const prev = this.me;
      if (prev && prev !== fetched) {
        for (const [bookId, rec] of Object.entries(prev.books || {})) {
          const cur = fetched.books[bookId];
          if (!cur || String(rec.at || '') > String(cur.at || '')) fetched.books[bookId] = rec;
        }
      }
      this.me = fetched;

      // локальный кэш библиотеки — на случай офлайна
      idb.put('cache:library', JSON.stringify(this.library), 'kv').catch(() => {});
      idb.put('cache:meta', JSON.stringify({ at: Date.now() }), 'kv').catch(() => {});

      this.setStatus('ok');
      this.emit('change');
      return this.library;
    } catch (e) {
      if (this.backend && this.backend.kind === 'github') {
        // пробуем подняться на кэше
        const cached = await idb.get('cache:library', 'kv').catch(() => null);
        if (cached) {
          try {
            this.library = JSON.parse(cached);
            this.offline = true;
            this.setStatus('err', e);
            this.emit('change');
            return this.library;
          } catch { /* ignore */ }
        }
      }
      this.setStatus('err', e);
      throw e;
    }
  }

  // -------------------------------------------------------------- прогресс

  /** Сводный прогресс: по каждой книге — самая свежая запись среди устройств. */
  merged() {
    const out = new Map();
    for (const [, file] of this.remote) {
      for (const [bookId, rec] of Object.entries(file.books || {})) {
        if (!rec || !rec.at) continue;
        const cur = out.get(bookId);
        if (!cur || new Date(rec.at) > new Date(cur.at)) {
          out.set(bookId, { ...rec, deviceId: file.deviceId, deviceName: file.deviceName || 'другое устройство' });
        }
      }
    }
    return out;
  }

  progressFor(bookId) {
    const rec = this.merged().get(bookId);
    return rec || null;
  }

  get lastBookId() {
    let best = null;
    for (const [id, r] of this.merged()) {
      if (!this.library.books.some((b) => b.id === id)) continue;
      if (!best || new Date(r.at) > new Date(best.at)) best = { id, at: r.at };
    }
    return best ? best.id : null;
  }

  /**
   * Записывает позицию в память и планирует отправку.
   *
   * Таймер намеренно НЕ переносится при каждом изменении. Если его переносить,
   * то при непрерывном чтении (событие прокрутки приходит чаще, чем задержка)
   * отправка не случилась бы никогда — позиция уходила бы в репозиторий только
   * после паузы, а при закрытии вкладки терялась бы.
   */
  async setProgress(bookId, anchor, pct, { immediate = false } = {}) {
    if (!this.me) return;
    this.me.books[bookId] = { a: anchor, pct: Math.max(0, Math.min(1, pct || 0)), at: new Date().toISOString() };
    this.me.updatedAt = new Date().toISOString();
    this.dirty = true;
    this.emit('progress', { bookId });
    if (immediate) return await this.flushProgress();
    if (this.pushTimer) return; // отправка уже запланирована — не откладываем её
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.flushProgress().catch(() => {});
    }, this.pushDelayMs);
  }

  /** Отправка не может идти параллельно сама с собой — иначе теряются записи. */
  async flushProgress() {
    if (!this.me) return;
    clearTimeout(this.pushTimer);
    this.pushTimer = null;
    if (this._pushing) { this._queued = true; return this._pushing; }
    this._pushing = this.#flushOnce().finally(() => {
      this._pushing = null;
      if (this._queued) { this._queued = false; this.flushProgress().catch(() => {}); }
    });
    return this._pushing;
  }

  async #flushOnce() {
    const did = this.device.id;
    this.me.deviceId = did;
    this.me.deviceName = this.device.name;
    const text = JSON.stringify(this.me, null, 1);
    idb.put(`cache:progress:${did}`, text, 'kv').catch(() => {});
    if (this.backend.kind === 'local') {
      await this.backend.putText(`progress/${did}.json`, text);
      this.dirty = false;
      this.emit('status', { status: 'ok' });
      return;
    }
    if (!this.dirty && this.lastPushText === text) return;
    this.setStatus('busy');
    try {
      await this.backend.putText(`progress/${did}.json`, text, 'Прогресс чтения');
      this.lastPushText = text;
      this.dirty = false;
      this.setStatus('ok');
    } catch (e) {
      this.setStatus('err', e);
      this.dirty = true;
      throw e;
    }
  }

  // ------------------------------------------------------ настройки/устройство

  async saveSettings(prefs) {
    if (!this.me) return;
    this.me.settings = { ...prefs, custom: true };
    this.me.settingsAt = new Date().toISOString();
    this.me.updatedAt = this.me.settingsAt;
    this.dirty = true;
    try { await this.flushProgress(); } catch { /* не критично */ }
  }

  remoteSettings() {
    let best = null;
    for (const [, f] of this.remote) {
      if (!f.settings || !f.settings.custom) continue;
      const at = f.settingsAt || f.updatedAt || '';
      if (!best || at > best.at) best = { at, settings: f.settings };
    }
    return best ? best.settings : null;
  }

  async renameDevice(name) {
    const d = setDeviceName(name);
    if (this.me) { this.me.deviceName = d.name; this.dirty = true; }
    this.emit('change');
  }

  devices() {
    return Array.from(this.remote.values()).map((f) => ({
      id: f.deviceId,
      name: f.deviceName || f.deviceId,
      updatedAt: f.updatedAt,
      books: Object.keys(f.books || {}).length,
    })).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }

  // ----------------------------------------------------------------- книги

  findBook(id) { return this.library.books.find((b) => b.id === id) || null; }

  async getBookBytes(book) {
    const bytes = await this.backend.getBytes(book.file);
    if (!bytes) throw new Error('Файл книги не найден в хранилище. Возможно, он был удалён.');
    return bytes;
  }

  async getCoverBlob(book) {
    if (!book.cover) return null;
    const local = await idb.get(`cover:${book.id}`).catch(() => null);
    if (local instanceof Blob) return local;
    const bytes = await this.backend.getBytes(book.cover);
    if (!bytes) return null;
    const blob = new Blob([bytes], { type: book.coverType || guessType(book.cover) });
    idb.put(`cover:${book.id}`, blob).catch(() => {});
    return blob;
  }

  /**
   * Добавляет книги. items: [{name, size, buffer, meta, coverBlob}]
   */
  async addBooks(items, onProgress = () => {}) {
    const addedAt = new Date().toISOString();
    const entries = [];
    const files = [];
    for (let k = 0; k < items.length; k++) {
      const it = items[k];
      onProgress(k, items.length, it.meta && it.meta.title);
      const id = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const file = `books/${id}.fb2`;
      files.push({ path: file, bytes: it.buffer });
      let cover = null, coverType = null;
      if (it.coverBlob) {
        coverType = it.coverBlob.type || 'image/jpeg';
        cover = `covers/${id}.${extOf(coverType)}`;
        files.push({ path: cover, bytes: await it.coverBlob.arrayBuffer() });
        idb.put(`cover:${id}`, it.coverBlob).catch(() => {});
      }
      entries.push({
        id,
        title: normSpace(it.meta.title) || normSpace(it.name.replace(/\.(fb2|zip)$/i, '')) || 'Без названия',
        author: normSpace(it.meta.author) || '',
        lang: it.meta.lang || '',
        sequence: it.meta.sequence || '',
        size: it.size || (it.buffer.byteLength || 0),
        file,
        cover,
        coverType,
        added: addedAt,
        addedBy: this.device.name,
      });
    }
    const lib = {
      ...this.library,
      version: 1,
      updatedAt: addedAt,
      books: [...this.library.books, ...entries],
    };
    files.push({ path: LIB_PATH, text: JSON.stringify(lib, null, 1) });
    onProgress(items.length, items.length, null);
    await this.backend.commitFiles(files, `Добавлено книг: ${entries.length}`);
    this.library = lib;
    await this.backend.refresh();
    this.emit('change');
    return entries;
  }

  async removeBook(id) {
    const book = this.findBook(id);
    if (!book) return;
    const files = [];
    if (book.file) files.push({ path: book.file, remove: true });
    if (book.cover) files.push({ path: book.cover, remove: true });
    const lib = {
      ...this.library,
      updatedAt: new Date().toISOString(),
      books: this.library.books.filter((b) => b.id !== id),
    };
    files.push({ path: LIB_PATH, text: JSON.stringify(lib, null, 1) });
    await this.backend.commitFiles(files, `Удалена книга: ${book.title}`);
    this.library = lib;
    if (this.me && this.me.books[id]) delete this.me.books[id];
    idb.del(`cover:${id}`).catch(() => {});
    await this.backend.refresh();
    this.emit('change');
  }

  /** Заменяет обложку книги (file — File/Blob с картинкой). */
  async setCover(id, blob) {
    const book = this.findBook(id);
    if (!book) throw new Error('Книга не найдена');
    const type = blob.type || 'image/jpeg';
    const path = `covers/${id}.${extOf(type)}`;
    await this.backend.commitFiles([{ path, bytes: await blob.arrayBuffer() }], `Обложка: ${book.title}`);
    idb.put(`cover:${id}`, blob).catch(() => {});
    await this.updateBookMeta(id, { cover: path, coverType: type });
  }

  async updateBookMeta(id, patch) {    const books = this.library.books.map((b) => (b.id === id ? { ...b, ...patch } : b));
    const lib = { ...this.library, updatedAt: new Date().toISOString(), books };
    this.library = lib;
    await this.backend.putText(LIB_PATH, JSON.stringify(lib, null, 1), `Правка книги: ${this.findBook(id)?.title || id}`);
    await this.backend.refresh();
    this.emit('change');
  }

  stats() {
    const merged = this.merged();
    const books = this.library.books;
    let read = 0, inProgress = 0;
    for (const b of books) {
      const p = merged.get(b.id);
      if (!p) continue;
      if (p.pct >= 0.995) read++;
      else if (p.pct > 0.005) inProgress++;
    }
    return { total: books.length, read, inProgress, unread: books.length - read - inProgress };
  }

  /** Полная очистка локального кэша (не трогает репозиторий). */
  async clearCache() {
    await idb.clear('files');
    await idb.clear('kv');
  }
}

function guessType(path) {
  if (/\.png$/i.test(path)) return 'image/png';
  if (/\.gif$/i.test(path)) return 'image/gif';
  if (/\.webp$/i.test(path)) return 'image/webp';
  return 'image/jpeg';
}

export { GhError };
