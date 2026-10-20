// Разбор и отрисовка FB2 (FictionBook 2.x).
// Возвращает готовый DOM-фрагмент + метаданные + карты ссылок.

import { h, normSpace } from './util.js';
import { isZip, unzipFirstFb2 } from './zip.js';

const XLINK = 'http://www.w3.org/1999/xlink';

export const BLOCK_SELECTOR = 'p, .fb2-t, .fb2-subtitle, .fb2-empty, .fb2-image, table, .fb2-annotation';

function all(root, name) {
  let list;
  try { list = root.getElementsByTagNameNS('*', name); } catch { list = null; }
  if (!list || !list.length) list = root.getElementsByTagName(name);
  return Array.from(list);
}
function first(root, name) { return all(root, name)[0] || null; }
function kids(el) { return Array.from(el.childNodes).filter((n) => n.nodeType === 1); }
function childNodes(el) { return Array.from(el.childNodes); }
function kid(el, name) { return kids(el).find((c) => c.localName === name) || null; }
function txt(el) { return el ? normSpace(el.textContent) : ''; }
function getHref(el) {
  return el.getAttributeNS(XLINK, 'href') || el.getAttribute('xlink:href') ||
    el.getAttribute('l:href') || el.getAttribute('href') || '';
}
function getAttrs(el) {
  const o = {};
  for (const a of Array.from(el.attributes)) o[a.localName] = a.value;
  return o;
}

const ENC_ALIASES = {
  'utf-8': 'utf-8', utf8: 'utf-8', 'utf-8bom': 'utf-8',
  'windows-1251': 'windows-1251', windows1251: 'windows-1251', cp1251: 'windows-1251',
  'win-1251': 'windows-1251', 'x-cp1251': 'windows-1251', 'ms-cp1251': 'windows-1251',
  'koi8-r': 'koi8-r', koi8r: 'koi8-r', 'koi8-u': 'koi8-u',
  'iso-8859-1': 'iso-8859-1', latin1: 'iso-8859-1', 'iso-8859-5': 'iso-8859-5',
  'ibm866': 'ibm866', cp866: 'ibm866', 'dos-866': 'ibm866',
  'utf-16': 'utf-16le', 'utf-16le': 'utf-16le', 'utf-16be': 'utf-16be',
};

function readDeclaredEncoding(b) {
  const head = new TextDecoder('latin1').decode(b.subarray(0, 1024));
  const m = head.match(/<\?xml[^>]*?encoding\s*=\s*["']([\w.:-]+)["']/i)
    || head.match(/encoding\s*=\s*["']([\w.:-]+)["']/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Определяет кодировку и декодирует буфер.
 *
 * Раньше проверялся фрагмент в 500 байт на «символы замены»: если обрыв попадал
 * на середину многобайтового символа, корректный UTF-8 принимался за
 * windows-1251 и весь текст превращался в «Р’СЃСЏ РєСЂРµРјР»РµРІСЃРєР°СЏ».
 * Теперь решение принимается по всему файлу.
 */
export function decodeXmlBuffer(buf) {
  const b = new Uint8Array(buf);
  if (b.length > 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder('utf-8').decode(b.subarray(3));
  if (b.length > 1 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b.length > 1 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));

  const declared = readDeclaredEncoding(b);
  const norm = declared ? (ENC_ALIASES[declared] || declared) : null;

  // 1. Весь файл — валидный UTF-8. Для настоящего текста это надёжнее декларации.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch { /* значит, действительно не UTF-8 */ }

  // 2. Явно объявлена другая кодировка — доверяем ей.
  if (norm && norm !== 'utf-8') {
    try { return new TextDecoder(norm).decode(b); } catch { /* кодировка неизвестна */ }
  }

  // 3. UTF-8 с единичными повреждёнными байтами: доля «замен» мала.
  const lossy = new TextDecoder('utf-8').decode(b);
  const bad = (lossy.match(/\uFFFD/g) || []).length;
  if (bad > 0 && bad / Math.max(1, lossy.length) < 0.05) return lossy;

  // 4. Частые кодировки русских FB2.
  for (const enc of ['windows-1251', 'koi8-r', 'ibm866']) {
    try { return new TextDecoder(enc).decode(b); } catch { /* ignore */ }
  }

  return lossy;
}

/** Читает FB2 из ArrayBuffer (.fb2 или .fb2.zip). */
export async function fb2TextFromBuffer(buf) {
  if (isZip(buf)) {
    const file = await unzipFirstFb2(buf);
    return { text: decodeXmlBuffer(file.data), innerName: file.name };
  }
  return { text: decodeXmlBuffer(buf), innerName: null };
}

// ---------------------------------------------------------------- отрисовка

function createCtx() {
  return {
    bin: new Map(),          // id -> {type, b64}
    urls: [],                // objectURL для отзыва
    urlCache: new Map(),
    pendingLinks: [],
    toc: [],
    sectionMap: new Map(),
    noteMap: new Map(),
  };
}

function binUrl(ctx, id) {
  if (!id) return null;
  if (ctx.urlCache.has(id)) return ctx.urlCache.get(id);
  const b = ctx.bin.get(id);
  if (!b) return null;
  let url = null;
  try {
    const bytes = Uint8Array.from(atob(b.b64.replace(/\s+/g, '')), (c) => c.charCodeAt(0));
    url = URL.createObjectURL(new Blob([bytes], { type: b.type || 'image/jpeg' }));
  } catch { url = null; }
  ctx.urlCache.set(id, url);
  if (url) ctx.urls.push(url);
  return url;
}

function binBlob(ctx, id) {
  const b = ctx.bin.get(id);
  if (!b) return null;
  try {
    const bytes = Uint8Array.from(atob(b.b64.replace(/\s+/g, '')), (c) => c.charCodeAt(0));
    return new Blob([bytes], { type: b.type || 'image/jpeg' });
  } catch { return null; }
}

function inline(list, ctx, mode, depth) {
  const out = [];
  for (const n of list) {
    if (n.nodeType === 3) {
      const t = n.nodeValue.replace(/\s+/g, ' ');
      if (t) out.push(document.createTextNode(t));
      continue;
    }
    if (n.nodeType !== 1) continue;
    const r = renderNode(n, ctx, mode, depth);
    if (r) out.push(...(Array.isArray(r) ? r : [r]));
  }
  return out;
}

function renderNode(n, ctx, mode, depth) {
  const name = n.localName;
  const id = n.getAttribute('id');

  switch (name) {
    case 'section':
      return renderSection(n, ctx, depth);

    case 'title':
      return h('div.fb2-title', ...inline(childNodes(n), ctx, 'title', depth));

    case 'p': {
      const el = mode === 'title' ? h('div.fb2-t') : h('p');
      if (id) el.id = 'fb2-' + id;
      el.append(...inline(childNodes(n), ctx, 'inline', depth));
      return el;
    }

    case 'subtitle':
      return h('div.fb2-subtitle', ...inline(childNodes(n), ctx, 'inline', depth));

    case 'empty-line':
      return h('div.fb2-empty');

    case 'emphasis': return h('em', ...inline(childNodes(n), ctx, 'inline', depth));
    case 'strong': return h('strong', ...inline(childNodes(n), ctx, 'inline', depth));
    case 'strikethrough': return h('s', ...inline(childNodes(n), ctx, 'inline', depth));
    case 'sub': return h('sub', ...inline(childNodes(n), ctx, 'inline', depth));
    case 'sup': return h('sup', ...inline(childNodes(n), ctx, 'inline', depth));
    case 'code': return h('code', ...inline(childNodes(n), ctx, 'inline', depth));
    case 'style': return h('span', { class: 'fb2-style' }, ...inline(childNodes(n), ctx, 'inline', depth));

    case 'a': {
      const href = getHref(n);
      const a = h('a', ...inline(childNodes(n), ctx, 'inline', depth));
      if (href) {
        if (href.startsWith('#')) {
          a.dataset.rawHref = href.slice(1);
          a.href = href;
          ctx.pendingLinks.push(a);
        } else {
          a.href = href;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
        }
      }
      return a;
    }

    case 'image': {
      const href = getHref(n);
      const bid = href.startsWith('#') ? href.slice(1) : href;
      const url = binUrl(ctx, bid);
      if (!url) return null;
      const img = h('img', { src: url, alt: n.getAttribute('title') || '', loading: 'lazy', decoding: 'async' });
      if (mode === 'inline') { img.className = 'fb2-img-inline'; return img; }
      return h('div.fb2-image', img);
    }

    case 'epigraph': return blockquote(n, ctx, 'fb2-epigraph', depth);
    case 'cite': return blockquote(n, ctx, 'fb2-cite', depth);

    case 'poem':
      return h('div.fb2-poem', ...inline(childNodes(n), ctx, null, depth));
    case 'stanza':
      return h('div.fb2-stanza', ...inline(childNodes(n), ctx, null, depth));
    case 'v':
      return h('p.fb2-v', ...inline(childNodes(n), ctx, 'inline', depth));

    case 'text-author':
      return h('div.fb2-author', ...inline(childNodes(n), ctx, 'inline', depth));
    case 'date':
      return h('div.fb2-date', ...inline(childNodes(n), ctx, 'inline', depth));

    case 'table': {
      const t = h('table.fb2-table');
      t.append(...inline(childNodes(n), ctx, null, depth));
      return t;
    }
    case 'tr': {
      const tr = h('tr');
      tr.append(...inline(childNodes(n), ctx, null, depth));
      return tr;
    }
    case 'th': case 'td': {
      const cell = h(name);
      for (const a of ['colspan', 'rowspan', 'align', 'valign']) {
        const v = n.getAttribute(a);
        if (v) cell.setAttribute(a, v);
      }
      cell.append(...inline(childNodes(n), ctx, 'inline', depth));
      return cell;
    }

    case 'annotation':
      return h('div.fb2-annotation', ...inline(childNodes(n), ctx, null, depth));

    case 'body':
    case 'FictionBook':
      return inline(childNodes(n), ctx, mode, depth);

    default: {
      // Неизвестный контейнер — разворачиваем прозрачно, но не теряем блоки.
      if (kids(n).length) return inline(childNodes(n), ctx, mode, depth);
      const t = normSpace(n.textContent);
      return t ? document.createTextNode(t) : null;
    }
  }
}

function blockquote(n, ctx, cls, depth) {
  return h('blockquote.' + cls, ...inline(childNodes(n), ctx, null, depth));
}

function renderSection(n, ctx, depth) {
  const el = h('section.fb2-section');
  const id = n.getAttribute('id');
  if (id) { el.id = 'fb2-' + id; ctx.sectionMap.set(id, el); }
  const children = kids(n);
  const titleEl = children.find((c) => c.localName === 'title');
  if (titleEl) {
    el.append(renderNode(titleEl, ctx, 'title', depth));
    const t = txt(titleEl);
    if (t) ctx.toc.push({ el, title: t.slice(0, 160), level: Math.min(depth, 3) });
  }
  for (const c of children) {
    if (c === titleEl) continue;
    const r = renderNode(c, ctx, null, depth + 1);
    if (r) el.append(...(Array.isArray(r) ? r : [r]));
  }
  return el;
}

// ---------------------------------------------------------------- метаданные

function extractMeta(root, fallbackTitle) {
  const desc = first(root, 'description');
  const ti = desc ? first(desc, 'title-info') : null;
  const meta = {
    title: fallbackTitle || 'Без названия',
    authors: [],
    author: '',
    annotation: '',
    lang: '',
    date: '',
    sequence: '',
    genres: [],
    coverId: null,
  };
  if (!ti) return meta;

  meta.title = txt(first(ti, 'book-title')) || meta.title;
  for (const a of all(ti, 'author')) {
    const nm = ['first-name', 'middle-name', 'last-name'].map((k) => txt(kid(a, k))).filter(Boolean).join(' ');
    const nick = txt(kid(a, 'nickname'));
    const name = normSpace([nm, nick ? `(${nick})` : ''].join(' '));
    if (name) meta.authors.push(name);
  }
  meta.author = meta.authors.join(', ');
  meta.lang = txt(first(ti, 'lang'));
  meta.date = txt(first(ti, 'date'));
  meta.annotation = txt(first(ti, 'annotation'));
  meta.genres = all(ti, 'genre').map(txt).filter(Boolean);
  const seq = first(ti, 'sequence');
  if (seq) {
    meta.sequence = normSpace([seq.getAttribute('name'), seq.getAttribute('number') ? `#${seq.getAttribute('number')}` : ''].join(' '));
  }
  const cover = first(ti, 'coverpage');
  if (cover) {
    const img = first(cover, 'image');
    if (img) {
      const hr = getHref(img);
      if (hr) meta.coverId = hr.startsWith('#') ? hr.slice(1) : hr;
    }
  }
  return meta;
}

/**
 * Главная точка входа.
 * @returns {{meta, content: DocumentFragment, notes: DocumentFragment, toc: Array,
 *            sectionMap: Map, noteMap: Map, coverBlob: Blob|null, coverUrl: string|null, revoke: Function}}
 */
export function parseFb2(xmlText, opts = {}) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const perr = doc.getElementsByTagName('parsererror')[0];
  if (perr) throw new Error('Файл не является корректным FB2/XML: ' + normSpace(perr.textContent).slice(0, 160));

  const root = doc.documentElement;
  if (!root || !/fictionbook/i.test(root.localName || '')) {
    // Бывает, что корень другой — но если есть body/section, попробуем всё равно
    if (!all(root, 'body').length) throw new Error('Это не FB2: не найден элемент <body>');
  }

  const ctx = createCtx();
  for (const b of all(root, 'binary')) {
    const id = b.getAttribute('id');
    if (!id) continue;
    ctx.bin.set(id, { type: b.getAttribute('content-type') || 'image/jpeg', b64: b.textContent || '' });
  }

  const meta = extractMeta(root, opts.fallbackTitle);
  const bodies = kids(root).filter((c) => c.localName === 'body');
  const notesBodies = bodies.filter((b) => /note|footnote|comment/i.test(b.getAttribute('name') || ''));
  const mainBodies = bodies.filter((b) => !notesBodies.includes(b));

  const content = document.createDocumentFragment();
  let depthBase = 1;
  for (const body of mainBodies) {
    const titleEl = kid(body, 'title');
    const frag = document.createDocumentFragment();
    if (titleEl) frag.append(renderNode(titleEl, ctx, 'title', 1));
    for (const c of kids(body)) {
      if (c === titleEl) continue;
      const r = renderNode(c, ctx, null, depthBase);
      if (r) frag.append(...(Array.isArray(r) ? r : [r]));
    }
    content.append(frag);
  }

  const notesHost = document.createElement('div');
  notesHost.className = 'fb2-notes';
  const tocBeforeNotes = ctx.toc.length;
  for (const body of notesBodies) {
    const host = document.createElement('div');
    host.className = 'fb2-notes-body';
    for (const c of kids(body)) {
      const r = renderNode(c, ctx, null, 1);
      if (r) host.append(...(Array.isArray(r) ? r : [r]));
    }
    notesHost.append(host);
  }
  // сноски не должны попадать в оглавление книги
  ctx.toc.length = tocBeforeNotes;
  // регистрируем сноски по их исходным id
  for (const el of Array.from(notesHost.querySelectorAll('[id]'))) {
    const raw = el.id.startsWith('fb2-') ? el.id.slice(4) : el.id;
    if (!ctx.noteMap.has(raw)) ctx.noteMap.set(raw, el);
  }

  // разрешаем внутренние ссылки
  for (const a of ctx.pendingLinks) {
    const raw = a.dataset.rawHref;
    delete a.dataset.rawHref;
    if (ctx.noteMap.has(raw)) {
      a.classList.add('fb2-noteref');
      a.dataset.noteId = raw;
      a.href = 'javascript:void 0';
      a.removeAttribute('href');
    } else if (ctx.sectionMap.has(raw)) {
      a.dataset.sectionId = raw;
      a.removeAttribute('href');
    } else {
      a.removeAttribute('href');
      a.classList.add('fb2-deadlink');
    }
  }

  let coverBlob = null, coverUrl = null;
  if (meta.coverId && ctx.bin.has(meta.coverId)) {
    coverBlob = binBlob(ctx, meta.coverId);
    coverUrl = binUrl(ctx, meta.coverId);
  }

  return {
    meta,
    content,
    notes: notesHost,
    toc: ctx.toc,
    sectionMap: ctx.sectionMap,
    noteMap: ctx.noteMap,
    coverBlob,
    coverUrl,
    revoke() {
      for (const u of ctx.urls) { try { URL.revokeObjectURL(u); } catch { /* ignore */ } }
      ctx.urls.length = 0;
      ctx.urlCache.clear();
    },
  };
}

/** Полный цикл: ArrayBuffer файла -> разобранная книга. */
export async function openFb2Buffer(buf, opts = {}) {
  const { text, innerName } = await fb2TextFromBuffer(buf);
  const fallback = opts.fallbackTitle || (innerName || '').replace(/\.fb2$/i, '').replace(/[._]+/g, ' ');
  return parseFb2(text, { fallbackTitle: fallback });
}
