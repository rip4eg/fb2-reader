// Просмотр папки на устройстве: поиск .fb2 / .fb2.zip и предварительные метаданные.
// Работает через File System Access API (Chrome/Edge на Windows),
// с откатом на <input webkitdirectory> и обычный выбор файлов.

import { decodeXmlBuffer } from './fb2.js';
import { isZip, unzipFirstFb2 } from './zip.js';
import { idb } from './util.js';

export const HEAD_BYTES = 128 * 1024;      // столько читаем для метаданных
export const MAX_ZIP_BYTES = 128 * 1024 * 1024;
const MAX_DEPTH = 6;

/** Расширения, которые вообще смотрим. */
export function isCandidateName(name) {
  return /\.(fb2|zip)$/i.test(String(name || ''));
}

/** Точное совпадение с книгой (архив может оказаться чем угодно, проверим по содержимому). */
export function isBookName(name) {
  return /\.(fb2|fb2\.zip)$/i.test(String(name || ''));
}

export function isZipName(name) {
  return /\.zip$/i.test(String(name || ''));
}

// --------------------------------------------------------------- метаданные

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, ' ');
}

function pick(scope, tag) {
  const m = scope.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? stripTags(decodeEntities(m[1])).replace(/\s+/g, ' ').trim() : '';
}

/**
 * Достаёт название и авторов из текста FB2 (можно обрезанного — без DOM).
 * Для показа в списке сканирования; при добавлении книга разбирается полностью.
 */
export function metaFromText(text) {
  const src = String(text || '');
  const tiBlock = src.match(/<title-info\b[\s\S]*?<\/title-info>/i);
  const scope = tiBlock ? tiBlock[0] : src;

  const title = pick(scope, 'book-title');
  const authors = [];
  const authorRe = /<author\b[^>]*>([\s\S]*?)<\/author>/gi;
  let m;
  while ((m = authorRe.exec(scope))) {
    const name = ['first-name', 'middle-name', 'last-name'].map((k) => pick(m[1], k)).filter(Boolean).join(' ');
    const nick = pick(m[1], 'nickname');
    const full = [name, nick && name ? `(${nick})` : nick].filter(Boolean).join(' ');
    if (full) authors.push(full);
  }
  const seq = scope.match(/<sequence\b([^>]*)>/i);
  let sequence = '';
  if (seq) {
    const nm = (seq[1].match(/name\s*=\s*"([^"]*)"/i) || [])[1] || '';
    const num = (seq[1].match(/number\s*=\s*"([^"]*)"/i) || [])[1] || '';
    sequence = [decodeEntities(nm), num && `#${num}`].filter(Boolean).join(' ');
  }
  return {
    ok: !!(title || authors.length),
    title: title || '',
    author: authors.join(', '),
    lang: pick(scope, 'lang'),
    sequence,
  };
}

/**
 * Читает только начало файла (или весь архив) и достаёт метаданные.
 * file — File/Blob.
 */
export async function peekMeta(file) {
  try {
    if (isZipName(file.name)) {
      if (file.size > MAX_ZIP_BYTES) return { ok: false, error: `архив больше ${Math.round(MAX_ZIP_BYTES / 1048576)} МБ` };
      const buf = await file.arrayBuffer();
      if (!isZip(buf)) return { ok: false, error: 'это не ZIP-архив' };
      const inner = await unzipFirstFb2(buf);
      return metaFromText(decodeXmlBuffer(inner.data));
    }

    const head = await file.slice(0, Math.min(HEAD_BYTES, file.size)).arrayBuffer();
    if (isZip(head)) {
      // редкий случай: .fb2, внутри которого zip — читаем целиком
      const buf = await file.arrayBuffer();
      const inner = await unzipFirstFb2(buf);
      return metaFromText(decodeXmlBuffer(inner.data));
    }
    const meta = metaFromText(decodeXmlBuffer(head));
    if (!meta.ok) return { ok: false, error: 'не похоже на FB2' };
    return meta;
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'не удалось прочитать' };
  }
}

// ------------------------------------------------------------------- обход

/** Обход каталога (FileSystemDirectoryHandle) с ограничением глубины. */
export async function walkDirectory(dir, prefix, acc, depth = 0) {
  if (depth > MAX_DEPTH) return acc;
  const iterator = typeof dir.entries === 'function'
    ? dir.entries()
    : (async function* fromValues() {
      for await (const h of dir.values()) yield [h.name, h];
    })();

  for await (const [name, handle] of iterator) {
    if (!name || name.startsWith('.')) continue;
    if (handle.kind === 'directory') {
      await walkDirectory(handle, prefix + name + '/', acc, depth + 1);
      continue;
    }
    acc.seen++;
    if (!isCandidateName(name)) continue;
    try {
      const file = await handle.getFile();
      acc.entries.push({ file, path: prefix + name, name, size: file.size });
    } catch { /* файл не читается — пропускаем */ }
    if (acc.onProgress && acc.seen % 5 === 0) acc.onProgress({ seen: acc.seen, found: acc.entries.length });
  }
  return acc;
}

/**
 * Сканирует источник.
 * source: {kind:'handle', handle, name} | {kind:'files', files, name}
 */
export async function scanSource(source, onProgress = () => {}) {
  const acc = { seen: 0, entries: [], onProgress };
  if (source.kind === 'files') {
    for (const file of source.files) {
      acc.seen++;
      if (!isCandidateName(file.name)) continue;
      acc.entries.push({ file, path: file.webkitRelativePath || file.name, name: file.name, size: file.size });
      if (acc.seen % 5 === 0) onProgress({ seen: acc.seen, found: acc.entries.length });
    }
  } else {
    await walkDirectory(source.handle, '', acc, 0);
  }
  onProgress({ seen: acc.seen, found: acc.entries.length, done: true });
  acc.entries.sort((a, b) => a.path.localeCompare(b.path, 'ru'));
  return { entries: acc.entries, seen: acc.seen };
}

// ------------------------------------------------------------- выбор источника

export function folderPickerAvailable() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

function pickWithInput(directory) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.fb2,.zip,.fb2.zip,application/xml,text/xml,application/zip';
    input.style.display = 'none';
    if (directory) input.setAttribute('webkitdirectory', '');
    document.body.append(input);

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };
    input.addEventListener('change', () => finish(Array.from(input.files || [])));
    input.addEventListener('cancel', () => finish(null));
    window.addEventListener('focus', () => {
      setTimeout(() => { if (!input.files || !input.files.length) finish(null); }, 600);
    }, { once: true });
    input.click();
  });
}

/** Открывает выбор папки. null — пользователь отменил. */
export async function pickFolder() {
  if (folderPickerAvailable()) {
    try {
      const handle = await window.showDirectoryPicker({ id: 'fb2-books', mode: 'read' });
      return { kind: 'handle', handle, name: handle.name };
    } catch (e) {
      if (e && e.name === 'AbortError') return null;
      // не поддерживается/запрещено — пробуем через input
    }
  }
  const files = await pickWithInput(true);
  if (!files) return null;
  const name = files[0] && files[0].webkitRelativePath ? String(files[0].webkitRelativePath).split('/')[0] : 'Выбранная папка';
  return { kind: 'files', files, name };
}

/** Открывает выбор отдельных файлов. */
export async function pickFiles() {
  const files = await pickWithInput(false);
  if (!files || !files.length) return null;
  const entries = files.map((f) => ({ file: f, path: f.name, name: f.name, size: f.size }));
  return { kind: 'files', files, name: `Файлы (${files.length})` };
}

// --------------------------------------------------- запоминание папки

export async function rememberFolder(handle) {
  try { await idb.put('scan:folder', handle, 'kv'); } catch { /* ignore */ }
}

export async function rememberedFolder() {
  try {
    const handle = await idb.get('scan:folder', 'kv');
    return handle && handle.kind === 'directory' ? handle : null;
  } catch { return null; }
}

export async function folderPermission(handle) {
  try {
    if (!handle || typeof handle.queryPermission !== 'function') return 'granted';
    return await handle.queryPermission({ mode: 'read' });
  } catch { return 'denied'; }
}

export async function requestFolderPermission(handle) {
  try {
    if (!handle || typeof handle.requestPermission !== 'function') return 'granted';
    return await handle.requestPermission({ mode: 'read' });
  } catch { return 'denied'; }
}

/**
 * Выполняет fn над элементами с ограничением параллельности.
 * Нужно, чтобы не открывать сотни файлов одновременно.
 */
export async function mapLimit(items, limit, fn, onEach) {
  const out = new Array(items.length);
  let next = 0;
  let done = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
      done++;
      if (onEach) onEach(done, items.length);
    }
  });
  await Promise.all(workers);
  return out;
}

// ------------------------------------------------------------- сравнение
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** Помечает книги, которые уже есть в библиотеке (по названию+автору либо по размеру). */
export function markExisting(entries, books) {
  const byKey = new Set();
  const sizes = new Set();
  for (const b of books || []) {
    byKey.add(norm(b.title) + '|' + norm(b.author));
    if (b.size) sizes.add(b.size);
  }
  return entries.map((e) => {
    const key = norm(e.meta && e.meta.title) + '|' + norm(e.meta && e.meta.author);
    const existing = byKey.has(key) || sizes.has(e.size);
    return { ...e, existing };
  });
}
