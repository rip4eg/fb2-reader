// Точка входа: маршрутизация, подключение, периодическая синхронизация.

import { h, mount, toast, $ } from './util.js';
import {
  parseLocation, buildHash, decodeCfg, encodeCfg, saveCfg, loadCfg,
  loadPrefs, savePrefs, applyTheme, applyReaderPrefs, DEFAULT_API,
} from './config.js';
import { Store } from './store.js';
import { Library } from './library.js';
import { Settings, renderSetup } from './settings.js';
import { Reader } from './reader.js';

class App {
  constructor() {
    this.store = new Store();
    this.prefs = loadPrefs();
    this.library = new Library(this);
    this.settings = new Settings(this);
    this.error = null;
    this.view = 'library';
    this.pollTimer = null;
    this.root = $('#app');
    this.reader = new Reader({
      store: this.store,
      getPrefs: () => this.prefs,
      setPrefs: (p) => this.setPrefs(p),
    });
    this.reader.onClose = () => {
      this.store.flushProgress().catch(() => {});
      this.view = 'library';
      buildHash({ cfg: this.cfgRaw, replace: false });
      this.render();
    };
  }

  // ---------------------------------------------------------------- запуск

  async start() {
    applyTheme(this.prefs);
    applyReaderPrefs(this.prefs);
    window.addEventListener('hashchange', () => this.route());
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
        if (this.prefs.theme === 'auto') applyTheme(this.prefs);
      });
    }

    const loc = parseLocation();
    this.cfgRaw = loc.cfg;

    let cfg = loc.cfg ? decodeCfg(loc.cfg) : null;
    if (cfg) saveCfg(cfg);
    else cfg = loadCfg();

    if (cfg) {
      this.cfgRaw = encodeCfg(cfg);
      try {
        await this.connect(cfg, { silent: true });
      } catch (e) {
        this.renderSetupWithError(e.message);
        return;
      }
      if (loc.view === 'read' && loc.id) {
        this.openBook(loc.id);
      } else if (loc.view === 'settings') {
        this.view = 'settings';
        this.render();
      } else {
        this.render();
      }
      buildHash({ cfg: this.cfgRaw, view: this.view === 'settings' ? 'settings' : null, replace: true });
      return;
    }

    if (loc.view === 'settings') { /* до подключения настроек нет */ }
    this.renderSetup();
  }

  async connect(cfg, { silent = false } = {}) {
    if (this.store && this.store.cfg && this.store.backend) {
      // переиспользуем существующий store
    }
    await this.store.connect(cfg);
    saveCfg(cfg);
    this.cfgRaw = encodeCfg(cfg);
    await this.store.refresh();
    const remote = this.store.remoteSettings();
    if (remote && !this.prefs.custom) {
      this.prefs = { ...this.prefs, ...remote, custom: true };
      savePrefs(this.prefs);
      applyTheme(this.prefs);
      applyReaderPrefs(this.prefs);
    }
    this.startPolling();
    if (!silent) { /* приветствие не нужно */ }
  }

  async useLocalMode() {
    await this.connect({ mode: 'local' });
    this.cfgRaw = null;
    toast('Локальный режим включён. Книги хранятся только в этом браузере.');
    buildHash({ replace: true });
    this.render();
  }

  startPolling() {
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (!this.store.cfg || this.store.cfg.mode === 'local') return;
      this.store.refresh().then(() => {
        if (this.store.status === 'ok' && !this.reader.bookId) this.updateSyncBadge();
        if (this.reader.bookId) {
          this.reader.setSync();
          const rec = this.store.progressFor(this.reader.bookId);
          if (rec) this.reader.offerRemote(rec);
        }
      }).catch(() => { this.updateSyncBadge(); });
    }, 60000);
  }

  // ---------------------------------------------------------------- вьюхи

  render() {
    if (this.reader.bookId) return; // читалка перекрывает всё
    const node = h('div');
    node.append(this.header());
    node.append(this.view === 'settings' ? this.settings.render() : this.library.render());
    mount(this.root, node);
    this.updateSyncBadge();
  }

  rerender() { this.render(); }

  rerenderKeepScroll() {
    const active = document.activeElement;
    const isSearch = active && active.type === 'search';
    const pos = isSearch ? active.selectionStart : null;
    const y = window.scrollY;
    this.render();
    window.scrollTo(0, y);
    if (isSearch) {
      const el = document.querySelector('input[type="search"]');
      if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch { /* ignore */ } }
    }
  }

  header() {
    const connected = !!(this.store.cfg);
    const onLib = this.view !== 'settings';
    return h('header.app-header',
      h('div.brand',
        h('div.logo', 'FB'),
        h('h1', 'Читалка FB2'),
      ),
      h('div.header-actions',
        this.syncBadge(),
        connected && this.store.cfg.mode !== 'local' ? h('span.badge', `${this.store.library.books.length} книг`) : null,
        h('button.btn' + (onLib ? '.primary' : ''), { onclick: () => this.nav('library') }, 'Библиотека'),
        h('button.btn' + (!onLib ? '.primary' : ''), { onclick: () => this.nav('settings') }, 'Настройки'),
      ),
    );
  }

  syncBadge() {
    this.badgeEl = h('span.badge');
    return this.badgeEl;
  }

  updateSyncBadge() {
    if (!this.badgeEl) return;
    const s = this.store.status;
    const cfg = this.store.cfg;
    if (!cfg) { this.badgeEl.textContent = 'не подключено'; this.badgeEl.className = 'badge err'; return; }
    if (cfg.mode === 'local') { this.badgeEl.textContent = 'локально'; this.badgeEl.className = 'badge'; return; }
    if (s === 'busy') { this.badgeEl.textContent = 'синхронизация…'; this.badgeEl.className = 'badge'; return; }
    if (s === 'err') { this.badgeEl.textContent = this.store.offline ? 'офлайн' : 'ошибка синхронизации'; this.badgeEl.className = 'badge err'; return; }
    this.badgeEl.textContent = 'синхронизировано';
    this.badgeEl.className = 'badge ok';
  }

  offlineNotice() {
    if (!this.store.offline) return null;
    return h('div.notice.err', { style: { marginTop: '.7rem' } },
      'Нет связи с GitHub — показана последняя сохранённая библиотека. ',
      this.store.error ? h('span.hint', this.store.error.message) : null);
  }

  nav(view) {
    this.view = view;
    buildHash({ cfg: this.cfgRaw, view: view === 'settings' ? 'settings' : null });
    this.render();
    window.scrollTo(0, 0);
  }

  openSetup() {
    this.view = 'setup';
    mount(this.root, h('div', this.header(), renderSetup(this)));
  }

  renderSetup() {
    mount(this.root, h('div', this.header(), renderSetup(this)));
  }

  renderSetupWithError(message) {
    this.error = message;
    mount(this.root, h('div', this.header(), renderSetup(this)));
  }

  errorNode() {
    if (!this.error) return null;
    const n = h('div.notice.err', this.error);
    this.error = null;
    return n;
  }

  showError(message) { this.error = message; }

  // ---------------------------------------------------------------- читалка

  openBook(id) {
    this.view = 'library';
    buildHash({ cfg: this.cfgRaw, view: 'read', id });
    this.reader.onClose = () => {
      this.store.flushProgress().catch(() => {});
      buildHash({ cfg: this.cfgRaw, replace: true });
      this.render();
    };
    this.reader.open(id);
  }

  route() {
    const loc = parseLocation();
    if (loc.cfg && loc.cfg !== this.cfgRaw) {
      const cfg = decodeCfg(loc.cfg);
      if (cfg) { saveCfg(cfg); location.reload(); return; }
    }
    if (loc.view === 'read' && loc.id) {
      if (this.reader.bookId !== loc.id) this.openBook(loc.id);
      return;
    }
    if (this.reader.bookId) { this.reader.close(); return; } // вернулись назад из книги
    this.view = loc.view === 'settings' ? 'settings' : 'library';
    this.render();
  }

  // ---------------------------------------------------------------- настройки

  getPrefs() { return this.prefs; }

  setPrefs(p) {
    this.prefs = { ...p };
    savePrefs(this.prefs);
    applyTheme(this.prefs);
    applyReaderPrefs(this.prefs);
    clearTimeout(this._prefsTimer);
    this._prefsTimer = setTimeout(() => {
      this.store.saveSettings(this.prefs).catch(() => {});
    }, 1200);
  }
}

const app = new App();
window.__app = app;

app.start().catch((e) => {
  console.error(e);
  mount($('#app'), h('div.wrap', h('div.card',
    h('h2', 'Не удалось запустить'),
    h('div.notice.err', e.message || String(e)),
    h('div.row', { style: { marginTop: '.8rem' } },
      h('button.btn', { onclick: () => location.reload() }, 'Перезагрузить'),
      h('button.btn.danger', { onclick: () => { localStorage.clear(); location.reload(); } }, 'Сбросить настройки'),
    ))));
});

// офлайн-режим приложения (кэш оболочки)
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// предупреждение о несохранённых данных
window.addEventListener('beforeunload', (e) => {
  if (app.store && app.store.dirty) {
    app.store.flushProgress().catch(() => {});
  }
});
