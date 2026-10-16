// Экран библиотеки: список книг, загрузка новых, прогресс.

import { h, mount, toast, confirmDlg, promptDlg, modal, backdrop, fmtBytes, fmtAgo, initials, escapeHtml } from './util.js';
import { openFb2Buffer } from './fb2.js';

const SORTS = [
  { v: 'recent', label: 'Недавние' },
  { v: 'title', label: 'По названию' },
  { v: 'author', label: 'По автору' },
  { v: 'added', label: 'По добавлению' },
];

export class Library {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.query = '';
    this.sort = localStorage.getItem('fbr.sort') || 'recent';
    this.coverUrls = new Map();
    this.io = null;
  }

  async openBook(id) { this.app.openBook(id); }

  render() {
    const store = this.store;
    const node = h('div.wrap');
    const books = store.library.books;
    const merged = store.merged();
    const stats = store.stats();
    const lastId = store.lastBookId;

    node.append(this.header(stats, books.length));
    if (lastId) node.append(this.continueCard(store.findBook(lastId), merged.get(lastId)));
    node.append(books.length ? this.filterRow(books.length, stats) : h('div'));

    const list = this.filtered();
    if (!books.length) {
      node.append(this.emptyState());
    } else if (!list.length) {
      node.append(h('div.empty', 'Ничего не найдено'));
    } else {
      const grid = h('div.grid');
      for (const b of list) grid.append(this.card(b, merged.get(b.id)));
      node.append(grid);
    }
    this.afterRender(node);
    return node;
  }

  header(stats, total) {
    return h('div.card',
      h('div.row',
        h('div', { style: { flex: '1 1 auto' } },
          h('strong', { style: { fontSize: '1.05rem' } }, 'Моя библиотека'),
          h('div.hint', `Книг: ${total} · прочитано: ${stats.read} · читаю: ${stats.inProgress}`)),
        h('button.btn.primary', { onclick: () => this.pickFiles() }, '＋ Добавить книгу'),
      ),
      this.app.offlineNotice(),
    );
  }

  continueCard(book, rec) {
    if (!book) return h('div');
    const img = h('img.cover-mini', { alt: '' });
    this.loadCover(book, img);
    return h('div.card.continue-card',
      img,
      h('div.grow',
        h('div.hint', 'Продолжить чтение'),
        h('div.t', book.title),
        h('div.a', (book.author || 'Автор неизвестен') + (rec ? ` · ${Math.round((rec.pct || 0) * 100)}% · ${fmtAgo(rec.at)}` : '')),
      ),
      h('button.btn.primary', { onclick: () => this.openBook(book.id) }, 'Читать'),
    );
  }

  filterRow() {
    const search = h('input.input', {
      type: 'search', placeholder: 'Поиск по названию или автору…', value: this.query,
      style: { maxWidth: '22rem' },
      oninput: (e) => {
        this.query = e.target.value;
        this.app.rerenderKeepScroll();
      },
    });
    const sel = h('select.input', {
      style: { maxWidth: '12rem' },
      onchange: (e) => { this.sort = e.target.value; localStorage.setItem('fbr.sort', this.sort); this.app.rerenderKeepScroll(); },
    }, ...SORTS.map((s) => h('option', { value: s.v, selected: this.sort === s.v }, s.label)));
    return h('div.row', { style: { margin: '1rem 0 .8rem' } }, search, sel);
  }

  filtered() {
    const q = this.query.trim().toLowerCase();
    let list = this.store.library.books.slice();
    if (q) {
      list = list.filter((b) => (b.title + ' ' + b.author).toLowerCase().includes(q));
    }
    const merged = this.store.merged();
    const at = (b) => { const r = merged.get(b.id); return r ? new Date(r.at).getTime() : 0; };
    if (this.sort === 'recent') list.sort((a, b) => at(b) - at(a) || a.title.localeCompare(b.title, 'ru'));
    else if (this.sort === 'title') list.sort((a, b) => a.title.localeCompare(b.title, 'ru'));
    else if (this.sort === 'author') list.sort((a, b) => (a.author || '').localeCompare(b.author || '', 'ru') || a.title.localeCompare(b.title, 'ru'));
    else list.sort((a, b) => String(b.added || '').localeCompare(String(a.added || '')));
    return list;
  }

  card(book, rec) {
    const pct = rec ? Math.max(0, Math.min(1, rec.pct || 0)) : 0;
    const thumb = h('button.thumb', { title: book.title, onclick: () => this.openBook(book.id) });
    const img = h('img', { alt: '', loading: 'lazy' });
    thumb.append(h('div', { style: { padding: '0 .5rem' } }, book.title.slice(0, 60)));
    img.dataset.cover = book.id;
    thumb.prepend(img);
    this.loadCover(book, img);

    const node = h('div.book',
      thumb,
      h('div.bt', book.title),
      h('div.ba', book.author || 'Автор неизвестен'),
      h('div.brow',
        h('div.bar', h('i', { style: { width: Math.round(pct * 100) + '%' } })),
        h('span.pct', Math.round(pct * 100) + '%')),
      h('button.btn.sm.ghost.menu-btn', {
        title: 'Действия',
        onclick: (e) => { e.stopPropagation(); this.bookMenu(e.currentTarget, book); },
      }, '⋯'),
    );
    return node;
  }

  loadCover(book, img) {
    if (!book.cover) { img.style.display = 'none'; return; }
    const cached = this.coverUrls.get(book.id);
    if (cached) { img.src = cached; img.style.display = ''; return; }
    img._load = async () => {
      try {
        const blob = await this.store.getCoverBlob(book);
        if (!blob) { img.remove(); return; }
        const url = URL.createObjectURL(blob);
        this.coverUrls.set(book.id, url);
        img.src = url;
        img.style.display = '';
      } catch { img.remove(); }
    };
  }

  afterRender(node) {
    if (this.io) { this.io.disconnect(); this.io = null; }
    const pending = Array.from(node.querySelectorAll('img')).filter((i) => i._load);
    const fire = (img) => { const f = img._load; img._load = null; if (f) f(); };
    if (!('IntersectionObserver' in window)) { pending.forEach(fire); return; }
    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { this.io.unobserve(e.target); fire(e.target); }
      }
    }, { rootMargin: '400px' });
    pending.forEach((img) => this.io.observe(img));
  }

  emptyState() {
    return h('div.empty',
      h('div', { style: { fontSize: '2rem' } }, '📚'),
      h('div', { style: { margin: '.5rem 0' } }, 'Библиотека пуста'),
      h('div.hint', { style: { marginBottom: '1rem' } }, 'Загрузите файл .fb2 или .fb2.zip — он появится здесь и будет доступен с любого устройства.'),
      h('button.btn.primary', { onclick: () => this.pickFiles() }, '＋ Добавить книгу'),
    );
  }

  bookMenu(anchorEl, book) {
    const rec = this.store.progressFor(book.id);
    const pop = h('div.menu-pop');
    const close = () => { pop.remove(); document.removeEventListener('mousedown', onDoc, true); };
    const onDoc = (e) => { if (!pop.contains(e.target)) close(); };
    const item = (label, fn, danger) => h('button', { class: danger ? 'danger' : '', onclick: () => { close(); fn(); } }, label);

    pop.append(
      item('Читать', () => this.openBook(book.id)),
      rec && rec.pct > 0.01 ? item('Начать заново', () => this.resetProgress(book)) : null,
      item('Скачать .fb2', () => this.downloadBook(book)),
      item('Переименовать', () => this.rename(book)),
      item('Загрузить обложку', () => this.uploadCover(book)),
      item('Удалить', () => this.remove(book), true),
    );
    document.body.append(pop);
    const r = anchorEl.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    pop.style.top = Math.min(r.bottom + 6, window.innerHeight - pr.height - 8) + 'px';
    pop.style.left = Math.max(8, Math.min(r.right - pr.width, window.innerWidth - pr.width - 8)) + 'px';
    setTimeout(() => document.addEventListener('mousedown', onDoc, true), 0);
  }

  // -------------------------------------------------------------- действия

  async resetProgress(book) {
    if (!(await confirmDlg('Начать заново?', `Отметка о прочтении «${book.title}» будет сброшена на всех устройствах.`, 'Сбросить'))) return;
    await this.store.setProgress(book.id, { i: 0, o: 0 }, 0, { immediate: true });
    toast('Позиция сброшена');
    this.app.rerender();
  }

  async downloadBook(book) {
    try {
      const buf = await this.store.getBookBytes(book);
      const { download } = await import('./util.js');
      const name = (book.author ? book.author + ' — ' : '') + book.title + '.fb2';
      download(new Blob([buf], { type: 'application/fb2+xml' }), name.replace(/[\\/:*?"<>|]/g, '_'));
    } catch (e) { toast(e.message, { error: true }); }
  }

  async rename(book) {
    const title = await promptDlg({ title: 'Название книги', label: 'Название', value: book.title });
    if (title == null) return;
    const author = await promptDlg({ title: 'Автор', label: 'Автор', value: book.author || '' });
    if (author == null) return;
    await this.store.updateBookMeta(book.id, { title: title || book.title, author });
    this.app.rerender();
  }

  async uploadCover(book) {
    const input = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
    document.body.append(input);
    input.onchange = async () => {
      const f = input.files[0];
      input.remove();
      if (!f) return;
      try {
        await this.store.setCover(book.id, f);
        const old = this.coverUrls.get(book.id);
        if (old) { URL.revokeObjectURL(old); this.coverUrls.delete(book.id); }
        this.app.rerender();
        toast('Обложка обновлена');
      } catch (e) { toast(e.message, { error: true }); }
    };
    input.click();
  }

  async remove(book) {
    if (!(await confirmDlg('Удалить книгу?', `«${book.title}» будет удалена из библиотеки на всех устройствах.`, 'Удалить'))) return;
    try {
      await this.store.removeBook(book.id);
      toast('Книга удалена');
      this.app.rerender();
    } catch (e) { toast(e.message, { error: true, ms: 7000 }); }
  }

  pickFiles() {
    const input = h('input', {
      type: 'file', multiple: true, accept: '.fb2,.zip,.fb2.zip,application/xml,text/xml,application/zip',
      style: { display: 'none' },
    });
    document.body.append(input);
    input.onchange = async () => {
      const files = Array.from(input.files || []);
      input.remove();
      if (files.length) await this.ingest(files);
    };
    input.click();
  }

  async ingest(files) {
    const box = h('div');
    const list = h('div.stack', { style: { maxHeight: '40vh', overflow: 'auto' } });
    const status = h('div.hint', 'Разбираю файлы…');
    box.append(status, list);
    const back = backdrop(h('div.modal', h('h3', 'Добавление книг'), box), null, 'modal-back');

    const items = [];
    for (const f of files) {
      const row = h('div.row', h('span.spinner'), h('span', f.name));
      list.append(row);
      try {
        const buf = await f.arrayBuffer();
        const parsed = await openFb2Buffer(buf, { fallbackTitle: f.name.replace(/\.(fb2|zip)$/i, '') });
        items.push({ name: f.name, size: f.size, buffer: buf, meta: parsed.meta, coverBlob: parsed.coverBlob, parsed });
        mount(row, h('span', '✓'), h('span', { style: { flex: '1 1 auto' } }, parsed.meta.title || f.name),
          h('span.hint', parsed.meta.author || ''));
      } catch (e) {
        mount(row, h('span', '⚠'), h('span', { style: { flex: '1 1 auto' } }, f.name),
          h('span.hint', { style: { color: 'var(--danger)' } }, e.message));
      }
    }

    for (const it of items) { if (it.parsed) it.parsed.revoke(); }

    if (!items.length) {
      mount(box, h('div.notice.err', 'Ни один файл не удалось прочитать. Нужен формат FB2 (.fb2 или .fb2.zip).'),
        h('div.row', { style: { justifyContent: 'flex-end', marginTop: '1rem' } },
          h('button.btn', { onclick: () => back.close() }, 'Закрыть')));
      return;
    }

    status.textContent = `Готово к загрузке: ${items.length}. Нажмите «Загрузить».`;
    const prog = h('div.bar', { style: { marginTop: '.8rem' } }, h('i', { style: { width: '0%' } }));
    const progText = h('div.hint');
    box.append(prog, progText);

    const btn = h('button.btn.primary', { onclick: async () => {
      btn.disabled = true;
      btn.textContent = 'Загружаю…';
      try {
        await this.store.addBooks(items.map((i) => ({ name: i.name, size: i.size, buffer: i.buffer, meta: i.meta, coverBlob: i.coverBlob })), (done, total, title) => {
          prog.firstChild.style.width = Math.round((done / total) * 100) + '%';
          progText.textContent = title ? `Загружено ${done} из ${total}: ${title}` : `Загружено ${done} из ${total}`;
        });
        back.close();
        toast(`Добавлено книг: ${items.length}`);
        this.app.rerender();
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Повторить';
        progText.textContent = 'Ошибка: ' + e.message;
      }
    } }, 'Загрузить');

    box.append(h('div.row', { style: { justifyContent: 'flex-end', marginTop: '1rem' } },
      h('button.btn', { onclick: () => back.close() }, 'Отмена'), btn));
  }
}
