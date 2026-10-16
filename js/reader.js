// Читалка: рендер FB2, отслеживание позиции, темы, шрифты, сноски, оглавление.

import { h, mount, clamp, throttle, debounce, toast, backdrop } from './util.js';
import { openFb2Buffer, BLOCK_SELECTOR } from './fb2.js';
import { indexBlocks, anchorAt as findAnchor, applyAnchor as scrollToAnchor, percentAt as percentOf } from './position.js';

const PAGE_PAD = 6; // отступ сверху, на который ориентируемся при восстановлении позиции

export class Reader {
  constructor({ store, getPrefs, setPrefs }) {
    this.store = store;
    this.getPrefs = getPrefs;
    this.setPrefs = setPrefs;
    this.book = null;
    this.bookId = null;
    this.parsed = null;
    this.blocks = [];
    this.root = null;
    this.pendingRemote = null;
    this.savePos = throttle(() => this.capture(), 900);
  }

  el(tag, attrs, ...kids) { return h(tag, attrs, ...kids); }

  build() {
    if (this.root) return this.root;
    const prefs = this.getPrefs();
    this.page = h('div.reader-page.fb2-body');
    if (prefs.align === 'left') this.page.classList.add('align-left');
    if (!prefs.hyphens) this.page.classList.add('no-hyphens');

    this.titleEl = h('div.reader-title');
    this.syncDot = h('span.sync-dot');
    this.pctLabel = h('span.pct', '0%');
    this.barFill = h('i', { style: { width: '0%' } });

    this.scroll = h('div.reader-scroll', this.page);
    this.notesHost = h('div.fb2-notes', { hidden: true });

    this.bar = h('div.reader-bar',
      h('button.btn.ghost.icon', { title: 'Назад (Esc)', onclick: () => this.close() }, '←'),
      this.titleEl,
      h('span.sep'),
      this.syncDot,
      h('button.btn.ghost.icon', { title: 'Оглавление', onclick: () => this.toggleToc() }, '☰'),
      h('button.btn.ghost.icon', { title: 'Сменить фон', onclick: () => this.cycleTheme() }, '◐'),
      h('button.btn.ghost.icon', { title: 'Настройки текста', onclick: () => this.openSettings() }, 'Aa'),
    );

    this.saveLabel = h('span.hint', { style: { whiteSpace: 'nowrap', minWidth: '6.5em', textAlign: 'right' } }, '');
    this.foot = h('div.reader-foot',
      this.pctLabel,
      h('div.bar', this.barFill),
      this.saveLabel,
      h('button.btn.ghost.sm', { title: 'Сохранить сейчас', onclick: () => this.syncNow() }, '⟳'),
    );

    this.root = h('div.reader', this.bar, this.scroll, this.foot, this.notesHost);

    if (!this._statusHooked) {
      this._statusHooked = true;
      const refresh = () => { if (this.bookId) this.setSync(); };
      this.store.addEventListener('status', refresh);
      this.store.addEventListener('change', refresh);
      this.store.addEventListener('progress', refresh);
    }

    this.scroll.addEventListener('scroll', () => {
      // Отличаем собственную программную прокрутку (восстановление позиции)
      // от прокрутки пользователем: после первой пользовательской прокрутки
      // восстановление больше не вмешивается, иначе читалку отбрасывало бы назад.
      const st = this.scroll.scrollTop;
      if (this._expectTop != null && Math.abs(st - this._expectTop) <= 2) {
        // это наша прокрутка
      } else {
        this.userScrolled = true;
      }
      this.updatePct();
      this.savePos();
      this.maybeHideBars();
    }, { passive: true });

    this.scroll.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a');
      if (a) {
        if (a.dataset.noteId) { e.preventDefault(); this.showNote(a.dataset.noteId); return; }
        if (a.dataset.sectionId) { e.preventDefault(); this.gotoSection(a.dataset.sectionId); return; }
        return;
      }
      const sel = String(window.getSelection ? window.getSelection() : '');
      if (sel && sel.length) return;
      this.root.classList.toggle('hide-bars');
    });

    document.addEventListener('keydown', this.onKey = (e) => this.handleKey(e));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flush();
    });
    window.addEventListener('pagehide', () => this.flush());
    return this.root;
  }

  // ------------------------------------------------------------- открытие

  async open(bookId) {
    const book = this.store.findBook(bookId);
    if (!book) { toast('Книга не найдена в библиотеке', { error: true }); return; }
    const root = this.build();
    document.body.append(root);
    document.body.style.overflow = 'hidden';
    // слушатель мог быть снят при закрытии предыдущей книги
    document.removeEventListener('keydown', this.onKey);
    document.addEventListener('keydown', this.onKey);
    this.root.classList.remove('hide-bars');
    this.bookId = bookId;
    this.book = book;
    this.titleEl.textContent = book.title + (book.author ? ' · ' + book.author : '');
    mount(this.page, h('div.empty', h('span.spinner'), ' Загрузка книги…'));
    this.blocks = [];
    this.setPct(0);

    let buf;
    try {
      buf = await this.store.getBookBytes(book);
    } catch (e) {
      mount(this.page, h('div.empty', e.message));
      toast(e.message, { error: true });
      return;
    }

    try {
      this.parsed = await openFb2Buffer(buf, { fallbackTitle: book.title });
    } catch (e) {
      mount(this.page, h('div.empty', 'Не удалось разобрать файл: ' + e.message));
      return;
    }

    const { meta, content, notes } = this.parsed;
    if (meta.author && !book.author) this.titleEl.textContent = meta.title + ' · ' + meta.author;
    const frag = document.createDocumentFragment();
    frag.append(content);
    if (this.parsed.coverUrl) {
      frag.prepend(h('div.fb2-cover', h('img', { src: this.parsed.coverUrl, alt: meta.title })));
    }
    mount(this.page, frag);
    mount(this.notesHost, notes);

    this.blocks = indexBlocks(this.page, BLOCK_SELECTOR);
    this.sectionTopsDirty = true;

    const rec = this.store.progressFor(bookId);
    const start = rec && rec.a ? rec.a : { i: 0, o: 0 };
    this.restoreAnchor = start;
    this.userScrolled = false;
    this._expectTop = null;
    this.restoreUntil = Date.now() + 5000; // пока пользователь не тронул прокрутку, доводим позицию
    await this.afterLayout(() => this.applyAnchor(this.restoreAnchor), 1200);
    this.updatePct();
    this.setSync();
  }

  /** Повторяет действие после того, как вёрстка успокоится (картинки, шрифты). */
  async afterLayout(fn, ms) {
    const run = () => { try { fn(); } catch { /* ignore */ } };
    requestAnimationFrame(run);
    [60, 200, 500].forEach((t) => setTimeout(run, t));
    if (this._layoutTimer) clearTimeout(this._layoutTimer);
    this._layoutTimer = setTimeout(run, ms);
    if (!this._imgHooked) {
      this._imgHooked = true;
      this.page.addEventListener('load', (e) => {
        if (e.target && e.target.tagName === 'IMG') this._relayout && this._relayout();
      }, true);
    }
    this._relayout = debounce(run, 120);
  }

  close() {
    this.flush();
    if (this.root) this.root.remove();
    document.body.style.overflow = '';
    document.removeEventListener('keydown', this.onKey);
    if (this.parsed && this.parsed.revoke) this.parsed.revoke();
    this.parsed = null;
    this.blocks = [];
    this.bookId = null;
    this.notesHost.replaceChildren();
    if (this.onClose) this.onClose();
  }

  // ------------------------------------------------------------- позиция

  capture() {
    if (!this.bookId || !this.blocks.length) return;
    const a = this.anchorAt();
    if (!a) return;
    this.store.setProgress(this.bookId, { i: a.i, o: a.o }, a.pct).catch(() => {});
    this.setPct(a.pct);
    this.setSync();
  }

  flush() {
    const a = (this.bookId && this.blocks.length) ? this.anchorAt() : null;
    if (a) {
      this.store.setProgress(this.bookId, { i: a.i, o: a.o }, a.pct, { immediate: true }).catch(() => {});
      this.setPct(a.pct);
      this.setSync();
    } else {
      this.store.flushProgress().catch(() => {});
    }
  }

  anchorAt() {
    return findAnchor(this.scroll, this.blocks, PAGE_PAD);
  }

  applyAnchor(a, force = false) {
    if (!this.blocks.length) return;
    // Пока пользователь не начал листать сам и не вышло время — доводим позицию
    // (вёрстка «съезжает», пока грузятся картинки и шрифты).
    if (!force && (this.userScrolled || Date.now() > this.restoreUntil)) return;
    if (!scrollToAnchor(this.scroll, this.blocks, a, PAGE_PAD)) {
      // книга изменилась — грузим по проценту
      this.scroll.scrollTop = (a.pct || 0) * this.scroll.scrollHeight;
    }
    this._expectTop = this.scroll.scrollTop;
  }

  setPct(p) {
    const v = Math.round(clamp(p, 0, 1) * 100);
    this.pctLabel.textContent = v + '%';
    this.barFill.style.width = v + '%';
  }

  updatePct() {
    if (!this.blocks.length) return;
    this.setPct(percentOf(this.scroll, this.blocks, PAGE_PAD));
  }

  maybeHideBars() {
    const y = this.scroll.scrollTop;
    const last = this._lastY || 0;
    if (Math.abs(y - last) < 24) return;
    this._lastY = y;
    if (y > last && y > 200) this.root.classList.add('hide-bars');
  }

  // ------------------------------------------------------------- навигация

  gotoSection(rawId) {
    const el = this.parsed && this.parsed.sectionMap.get(rawId);
    if (!el) return;
    const cRect = this.scroll.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    this.scroll.scrollTop = Math.max(0, this.scroll.scrollTop + (r.top - cRect.top) - PAGE_PAD);
  }

  handleKey(e) {
    if (!this.bookId) return;
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    const page = this.scroll.clientHeight - 40;
    switch (e.key) {
      case 'Escape': this.close(); break;
      case 'ArrowRight': case 'PageDown': case ' ':
        this.scroll.scrollBy({ top: page, behavior: 'smooth' }); e.preventDefault(); break;
      case 'ArrowLeft': case 'PageUp':
        this.scroll.scrollBy({ top: -page, behavior: 'smooth' }); e.preventDefault(); break;
      case 'ArrowDown': this.scroll.scrollBy({ top: 60, behavior: 'smooth' }); e.preventDefault(); break;
      case 'ArrowUp': this.scroll.scrollBy({ top: -60, behavior: 'smooth' }); e.preventDefault(); break;
      case 'Home': this.scroll.scrollTo({ top: 0, behavior: 'smooth' }); e.preventDefault(); break;
      case 'End': this.scroll.scrollTo({ top: this.scroll.scrollHeight, behavior: 'smooth' }); e.preventDefault(); break;
      default: break;
    }
  }

  // ------------------------------------------------------------- сноски/оглавление

  showNote(rawId) {
    const el = this.parsed && this.parsed.noteMap.get(rawId);
    if (!el) { toast('Сноска не найдена в файле'); return; }
    const body = h('div');
    body.innerHTML = el.innerHTML;
    const pop = h('div.popup',
      h('div.popup-head', h('div.t', 'Примечание'), h('button.btn.ghost.icon', { onclick: () => back.close() }, '✕')),
      body);
    const back = backdrop(pop);
  }

  toggleToc() {
    if (this.tocPanel) { this.tocPanel.remove(); this.tocPanel = null; return; }
    const toc = (this.parsed && this.parsed.toc) || [];
    const list = h('div.toc-list');
    if (!toc.length) list.append(h('div.hint', { style: { padding: '1rem' } }, 'В файле нет оглавления'));
    for (const item of toc) {
      list.append(h('button', {
        class: 'lvl' + item.level,
        onclick: () => {
          const cRect = this.scroll.getBoundingClientRect();
          const r = item.el.getBoundingClientRect();
          this.scroll.scrollTop = Math.max(0, this.scroll.scrollTop + (r.top - cRect.top) - PAGE_PAD);
          this.toggleToc();
        },
      }, item.title));
    }
    this.tocPanel = h('div.toc-panel',
      h('div.toc-head', h('strong', 'Оглавление'), h('span.sep'),
        h('button.btn.ghost.icon', { onclick: () => this.toggleToc() }, '✕')),
      list);
    this.root.append(this.tocPanel);
  }

  // ------------------------------------------------------------- настройки

  cycleTheme() {
    const order = ['light', 'sepia', 'dark'];
    const p = this.getPrefs();
    const i = order.indexOf(p.theme);
    const next = order[(i + 1) % order.length];
    this.setPrefs({ ...p, theme: next, custom: true });
    toast('Фон: ' + ({ light: 'белый', sepia: 'сепия', dark: 'чёрный' }[next]));
  }

  openSettings() {
    const prefs = this.getPrefs();
    const set = (patch) => {
      const p = { ...this.getPrefs(), ...patch, custom: true };
      this.setPrefs(p);
      this.refreshStyle(p);
      render();
    };

    const seg = (name, options, cur, fmt) => h('div.seg', ...options.map((o) => h('button', {
      'aria-pressed': String(cur === o.v),
      onclick: () => set({ [name]: o.v }),
    }, fmt ? fmt(o) : o.label)));

    const render = () => {
      const p = this.getPrefs();
      mount(sheet,
        h('h3', 'Настройки текста'),
        h('div.group',
          h('div.lbl', 'Фон'),
          seg('theme', [
            { v: 'light', label: 'Белый' },
            { v: 'sepia', label: 'Бумага' },
            { v: 'dark', label: 'Чёрный' },
            { v: 'auto', label: 'Как в системе' },
          ], p.theme)),
        h('div.group',
          h('div.lbl', 'Шрифт'),
          seg('fontFamily', [
            { v: 'serif', label: 'С засечками' },
            { v: 'sans', label: 'Без засечек' },
            { v: 'mono', label: 'Моно' },
          ], p.fontFamily)),
        h('div.group',
          h('div.lbl', `Размер текста: ${p.fontSize}px`),
          h('input', {
            type: 'range', min: 12, max: 34, step: 1, value: p.fontSize,
            oninput: (e) => set({ fontSize: Number(e.target.value) }),
          })),
        h('div.group',
          h('div.lbl', `Межстрочный интервал: ${p.lineHeight.toFixed(2)}`),
          h('input', {
            type: 'range', min: 1.1, max: 2.2, step: 0.05, value: p.lineHeight,
            oninput: (e) => set({ lineHeight: Number(e.target.value) }),
          })),
        h('div.group',
          h('div.lbl', `Ширина колонки: ${p.pageWidth}rem`),
          h('input', {
            type: 'range', min: 26, max: 70, step: 1, value: p.pageWidth,
            oninput: (e) => set({ pageWidth: Number(e.target.value) }),
          })),
        h('div.group',
          h('div.lbl', 'Выравнивание'),
          seg('align', [{ v: 'justify', label: 'По ширине' }, { v: 'left', label: 'По левому краю' }], p.align)),
        h('div.group',
          h('div.lbl', 'Переносы слов'),
          seg('hyphens', [{ v: true, label: 'Вкл' }, { v: false, label: 'Выкл' }], p.hyphens)),
        h('div.row', h('button.btn', { onclick: () => {
          set({ theme: 'light', fontSize: 19, lineHeight: 1.6, pageWidth: 42, fontFamily: 'serif', align: 'justify', hyphens: true });
        } }, 'Сбросить')),
      );
    };

    const sheet = h('div.sheet');
    const back = backdrop(sheet, () => { this.scrollToKeep(); }, 'sheet-back');
    render();
    const self = this;
    this.scrollToKeep = function () { self.afterLayout(() => self.updatePct(), 300); };
  }

  refreshStyle(prefs) {
    this.page.classList.toggle('align-left', prefs.align === 'left');
    this.page.classList.toggle('no-hyphens', !prefs.hyphens);
    // после смены шрифта позицию сохраняем
    const a = this.blocks.length ? this.anchorAt() : null;
    if (a) this.afterLayout(() => this.applyAnchor(a, true), 400);
  }

  // ------------------------------------------------------------- синхронизация

  setSync() {
    const s = this.store.status;
    this.syncDot.className = 'sync-dot' + (s === 'busy' ? ' busy' : s === 'err' ? ' err' : s === 'idle' ? '' : ' ok');
    const where =
      s === 'busy' ? 'Сохраняю…' :
      s === 'err' ? 'Не сохранено: ' + (this.store.error ? this.store.error.message : 'ошибка') :
      this.store.offline ? 'Офлайн, показан кэш' :
      'Сохранено ' + new Date(this.store.lastSyncAt || Date.now()).toLocaleTimeString('ru-RU');
    this.syncDot.title = where;
    if (this.saveLabel) {
      this.saveLabel.textContent =
        s === 'busy' ? 'сохраняю…' :
        s === 'err' ? 'не сохранено' :
        this.store.dirty ? 'есть несохранённое' :
        'сохранено';
    }
  }

  async syncNow() {
    this.setSync();
    try {
      await this.store.flushProgress();
      await this.store.refresh();
      this.setSync();
      toast('Синхронизировано');
    } catch (e) {
      this.setSync();
      toast(e.message, { error: true, ms: 6000 });
    }
  }

  /** Вызывается приложением, когда в репозитории появилась более свежая позиция. */
  offerRemote(rec) {
    if (!this.bookId || !rec) return;
    if (rec.deviceId === this.store.device.id) return;
    const cur = this.anchorAt();
    if (rec.pct != null && cur && Math.abs(rec.pct - cur.pct) < 0.02) return;
    const at = new Date(rec.at).getTime();
    if (Date.now() - at < 20000) return;
    toast(`${rec.deviceName || 'Другое устройство'}: ${Math.round((rec.pct || 0) * 100)}% — более новая позиция`, {
      ms: 12000,
      action: {
        label: 'Перейти',
        fn: () => { this.applyAnchor(rec.a || { pct: rec.pct }, true); this.updatePct(); },
      },
    });
  }
}
