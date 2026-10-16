// Общие утилиты: DOM, base64, время, тосты, диалоги.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** h('div.foo', {attrs}, ...children) — быстрый конструктор DOM. */
export function h(tag, attrs, ...children) {
  const [name, ...classes] = String(tag).split('.');
  const node = document.createElement(name || 'div');
  for (const c of classes) if (c) node.classList.add(c);
  if (attrs && typeof attrs === 'object' && !(attrs instanceof Node) && !Array.isArray(attrs)) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'value') node.value = v;
      else node.setAttribute(k, v === true ? '' : String(v));
    }
  } else if (attrs != null) {
    children.unshift(attrs);
  }
  add(node, children);
  return node;
}

function add(node, children) {
  for (const ch of children.flat(4)) {
    if (ch == null || ch === false) continue;
    node.append(ch instanceof Node ? ch : document.createTextNode(String(ch)));
  }
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
export function mount(node, ...children) { clear(node); add(node, children); return node; }

// ---------- base64 / байты ----------
export function b64ToBytes(b64) {
  const clean = String(b64).replace(/[\s\r\n]+/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64(bytes, chunk = 0x8000) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  return btoa(s);
}

export const utf8ToB64 = (str) => bytesToB64(new TextEncoder().encode(str));
export const b64ToUtf8 = (b64) => new TextDecoder().decode(b64ToBytes(b64));

export function b64urlEncode(str) {
  return utf8ToB64(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64urlDecode(s) {
  let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  return b64ToUtf8(t);
}

// ---------- прочее ----------
export function debounce(fn, ms) {
  let t = 0;
  const w = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  w.flush = (...a) => { clearTimeout(t); fn(...a); };
  w.cancel = () => clearTimeout(t);
  return w;
}

export function throttle(fn, ms) {
  let last = 0, timer = 0, pending = null;
  return (...a) => {
    pending = a;
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(...pending); }
    else if (!timer) {
      timer = setTimeout(() => { timer = 0; last = Date.now(); fn(...pending); }, ms - (now - last));
    }
  };
}

export function uid(prefix = '') {
  const r = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    : Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return prefix + r;
}

export function fmtBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' Б';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' КБ';
  return (n / 1048576).toFixed(1) + ' МБ';
}

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtAgo(iso) {
  if (!iso) return '';
  const d = new Date(iso).getTime();
  if (!d) return '';
  const s = Math.max(0, (Date.now() - d) / 1000);
  if (s < 60) return 'только что';
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} дн назад`;
  return fmtDate(iso);
}

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function normSpace(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

export function slug(s) {
  return normSpace(s).toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'book';
}

export function initials(title) {
  return normSpace(title).split(' ').slice(0, 2).map((w) => w[0] || '').join('').toUpperCase();
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// ---------- тосты и диалоги ----------
let toastBox = null;
function ensureToasts() {
  if (!toastBox) { toastBox = h('div.toasts'); document.body.append(toastBox); }
  return toastBox;
}

export function toast(message, opts = {}) {
  const { ms = 3200, action, error = false } = opts;
  const box = ensureToasts();
  const node = h('div.toast' + (error ? '.err' : ''),
    h('div.grow', { text: message }),
    action ? h('button.btn.sm', { onclick: () => { action.fn(); node.remove(); } }, action.label) : null,
    h('button.btn.sm.ghost', { 'aria-label': 'Закрыть', onclick: () => node.remove() }, '✕'));
  box.append(node);
  if (ms > 0) setTimeout(() => node.remove(), ms);
  return node;
}

export function backdrop(inner, onClose, cls = 'popup-back') {
  const back = h('div.' + cls);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  function close() { document.removeEventListener('keydown', esc, true); back.remove(); if (onClose) onClose(); }
  back.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('keydown', esc, true);
  back.append(inner);
  document.body.append(back);
  return { node: back, close };
}

export function modal({ title, body, actions = [], onClose }) {
  const content = h('div.modal');
  if (title) content.append(h('h3', { text: title }));
  if (body) content.append(body);
  const row = h('div.actions');
  let handle;
  for (const a of actions) {
    row.append(h('button.btn' + (a.primary ? '.primary' : '') + (a.danger ? '.danger' : ''), {
      onclick: async () => {
        if (a.onClick) { const r = await a.onClick(handle); if (r === false) return; }
        handle.close();
      },
    }, a.label));
  }
  content.append(row);
  handle = backdrop(content, onClose || (() => {}), 'modal-back');
  return handle;
}

export function confirmDlg(title, text, confirmLabel = 'Удалить') {
  return new Promise((resolve) => {
    modal({
      title,
      body: h('div', h('p', { text })),
      actions: [
        { label: 'Отмена', onClick: () => { resolve(false); } },
        { label: confirmLabel, danger: true, primary: true, onClick: () => { resolve(true); } },
      ],
      onClose: () => resolve(false),
    });
  });
}

export function promptDlg({ title, label, value = '', placeholder = '', type = 'text' }) {
  return new Promise((resolve) => {
    const input = h('input.input', { type, value, placeholder });
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const m = modal({
      title,
      body: h('label.field', h('span', { text: label || '' }), input),
      actions: [
        { label: 'Отмена', onClick: () => done(null) },
        { label: 'OK', primary: true, onClick: () => done(input.value.trim()) },
      ],
      onClose: () => done(null),
    });
    setTimeout(() => { input.focus(); input.select(); }, 30);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { done(input.value.trim()); m.close(); } });
  });
}

// ---------- IndexedDB: кэш файлов ----------
const DB_NAME = 'fb2-reader';
const DB_VER = 1;
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    try { out = fn(s); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const idb = {
  get: (key, store = 'files') => tx(store, 'readonly', (s) => s.get(key)),
  put: (key, val, store = 'files') => tx(store, 'readwrite', (s) => s.put(val, key)),
  del: (key, store = 'files') => tx(store, 'readwrite', (s) => s.delete(key)),
  clear: (store = 'files') => tx(store, 'readwrite', (s) => s.clear()),
  async keys(store = 'files') {
    return tx(store, 'readonly', (s) => s.getAllKeys());
  },
};
