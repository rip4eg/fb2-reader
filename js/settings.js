// Экран настроек и первичная настройка подключения.

import { h, mount, toast, modal, backdrop, fmtAgo, confirmDlg, promptDlg, fmtBytes, idb } from './util.js';
import { GitHubApi } from './gh.js';
import { encodeCfg, shareLink, saveCfg, DEFAULT_API } from './config.js';

export class Settings {
  constructor(app) { this.app = app; this.store = app.store; }

  render() {
    const node = h('div.wrap');
    node.append(this.connectionCard(), this.devicesCard(), this.readingCard(), this.storageCard(), this.aboutCard());
    return node;
  }

  connectionCard() {
    const store = this.store;
    const cfg = store.cfg || {};
    const isLocal = !cfg || cfg.mode === 'local';
    const card = h('div.card', h('h2', 'Хранилище и синхронизация'));

    if (isLocal) {
      card.append(
        h('div.notice', 'Сейчас включён локальный режим: книги и прогресс хранятся только в этом браузере и не переносятся на другие устройства.'),
        h('div.row', { style: { marginTop: '.8rem' } },
          h('button.btn.primary', { onclick: () => this.app.openSetup() }, 'Подключить GitHub-синхронизацию')),
      );
      return card;
    }

    const repoUrl = `https://github.com/${cfg.owner}/${cfg.repo}`;
    const link = shareLink(cfg);
    const linkBox = h('input.input.mono', { value: link, readonly: true, onfocus: (e) => e.target.select() });

    card.append(
      h('div.stack',
        h('div.row',
          h('span.badge' + (store.status === 'err' ? '.err' : '.ok'),
            store.offline ? 'офлайн' : store.status === 'err' ? 'ошибка' : 'подключено'),
          h('span.hint', `Записей прогресса: ${store.devices().length}`),
        ),
        h('div.hint', 'Репозиторий с данными: ',
          h('a', { href: repoUrl, target: '_blank', rel: 'noopener' }, `${cfg.owner}/${cfg.repo}`),
          ` · ветка ${cfg.branch}`),
        h('div.hint', { style: { marginTop: '.4rem' } }, 'Устройство: '),
        h('div.row',
          h('input.input', {
            value: store.device.name, style: { maxWidth: '18rem' },
            onchange: async (e) => { await store.renameDevice(e.target.value); this.app.rerender(); },
          }),
          h('button.btn', { onclick: () => this.testConnection() }, 'Проверить связь'),
          h('button.btn', { onclick: () => store.refresh().then(() => this.app.rerender()).catch((e) => toast(e.message, { error: true })) }, 'Обновить'),
        ),
        h('h3', 'Ссылка для нового устройства'),
        h('div.hint', 'Откройте её на телефоне или планшете — библиотека и позиция чтения подтянутся автоматически. В ссылке зашит токен доступа, поэтому не публикуйте её.'),
        linkBox,
        h('div.row',
          h('button.btn.primary', { onclick: () => this.copy(link) }, 'Скопировать ссылку'),
          h('button.btn', { onclick: () => this.showQr(link) }, 'Показать QR'),
          h('button.btn.danger', { onclick: () => this.forget() }, 'Отключить'),
        ),
      ),
    );
    return card;
  }

  devicesCard() {
    const list = this.store.devices();
    const card = h('div.card', h('h2', 'Устройства'));
    const box = h('div.stack');
    const me = this.store.device.id;
    for (const d of list) {
      box.append(h('div.row',
        h('span', { style: { flex: '1 1 auto' } },
          h('strong', d.name + (d.id === me ? ' (это устройство)' : '')),
          h('div.hint', `${d.books} книг(и) · обновлено ${fmtAgo(d.updatedAt)}`)),
        d.id !== me ? h('span.badge', 'только чтение') : null,
      ));
    }
    if (!list.length) box.append(h('div.hint', 'Пока нет данных прогресса.'));
    card.append(box);
    return card;
  }

  readingCard() {
    const prefs = this.app.getPrefs();
    const set = (patch) => this.app.setPrefs({ ...this.app.getPrefs(), ...patch, custom: true });
    const seg = (name, opts, cur, fmt) => h('div.seg', ...opts.map((o) => h('button', {
      'aria-pressed': String(cur === o.v || (cur === o.v)),
      onclick: () => { set({ [name]: o.v }); this.app.rerender(); },
    }, fmt ? fmt(o) : o.label)));

    return h('div.card',
      h('h2', 'Оформление'),
      h('div.group', h('div.lbl', 'Фон'),
        seg('theme', [
          { v: 'light', label: 'Белый' },
          { v: 'sepia', label: 'Бумага' },
          { v: 'dark', label: 'Чёрный' },
          { v: 'auto', label: 'Как в системе' },
        ], prefs.theme)),
      h('div.group', h('div.lbl', 'Шрифт'),
        seg('fontFamily', [{ v: 'serif', label: 'С засечками' }, { v: 'sans', label: 'Без засечек' }, { v: 'mono', label: 'Моно' }], prefs.fontFamily)),
      h('div.group', h('div.lbl', `Размер текста: ${prefs.fontSize}px`),
        h('input', { type: 'range', min: 12, max: 34, step: 1, value: prefs.fontSize, oninput: (e) => set({ fontSize: Number(e.target.value) }) })),
      h('div.group', h('div.lbl', `Интервал: ${Number(prefs.lineHeight).toFixed(2)}`),
        h('input', { type: 'range', min: 1.1, max: 2.2, step: 0.05, value: prefs.lineHeight, oninput: (e) => set({ lineHeight: Number(e.target.value) }) })),
      h('div.group', h('div.lbl', 'Ширина колонки'),
        h('input', { type: 'range', min: 26, max: 70, step: 1, value: prefs.pageWidth, oninput: (e) => set({ pageWidth: Number(e.target.value) }) })),
      h('div.group', h('div.lbl', 'Выравнивание'),
        seg('align', [{ v: 'justify', label: 'По ширине' }, { v: 'left', label: 'По левому краю' }], prefs.align)),
    );
  }

  storageCard() {
    const card = h('div.card', h('h2', 'Данные на этом устройстве'));
    const info = h('div.hint', 'Кэш книг ускоряет открытие и позволяет читать без интернета.');
    card.append(info, h('div.row', { style: { marginTop: '.6rem' } },
      h('button.btn', { onclick: async () => { await this.store.clearCache(); this.app.rerender(); toast('Кэш очищен'); } }, 'Очистить кэш книг'),
      h('button.btn.danger', { onclick: async () => { await this.store.clearCache(); localStorage.clear(); location.reload(); } }, 'Сбросить всё и выйти'),
    ));
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then((est) => {
        info.textContent = `Занято этим сайтом: ${fmtBytes(est.usage || 0)}. Кэш книг ускоряет открытие и позволяет читать без интернета.`;
      }).catch(() => {});
    }
    return card;
  }

  aboutCard() {
    return h('div.card',
      h('h2', 'О программе'),
      h('div.hint',
        'Читалка FB2 без сервера: приложение лежит на GitHub Pages, а библиотека и позиции чтения — в вашем приватном репозитории. ',
        'Позиция сохраняется как «блок текста + доля внутри него», поэтому не сбивается при смене размера шрифта или устройства.'),
      h('div.hint', { style: { marginTop: '.5rem' } },
        'Горячие клавиши: ← → — страницы, Home/End — начало и конец, Esc — выход из книги.'),
    );
  }

  // ------------------------------------------------------------- действия

  async copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Ссылка скопирована');
    } catch {
      const ta = h('textarea.input', { style: { height: '8rem' } });
      ta.value = text;
      const m = modal({ title: 'Скопируйте ссылку вручную', body: ta, actions: [{ label: 'Готово', primary: true }] });
      setTimeout(() => { ta.focus(); ta.select(); }, 50);
    }
  }

  showQr(link) {
    const body = h('div', { style: { textAlign: 'center' } });
    const img = h('img', { style: { width: 'min(70vw, 320px)', imageRendering: 'pixelated' }, alt: 'QR' });
    body.append(img, h('div.hint', { style: { marginTop: '.6rem' } }, 'Отсканируйте камерой телефона'));
    modal({ title: 'QR-код со ссылкой', body });
    this.qr(link).then((url) => { img.src = url; }).catch(() => {
      mount(body, h('div.notice.err', 'Не удалось построить QR (нет интернета). Используйте кнопку «Скопировать ссылку».'));
    });
  }

  /** Простейший QR через внешний сервис — если он недоступен, останется ссылка. */
  async qr(link) {
    const url = 'https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=' + encodeURIComponent(link);
    const res = await fetch(url);
    if (!res.ok) throw new Error('qr');
    return URL.createObjectURL(await res.blob());
  }

  async testConnection() {
    const t = toast('Проверяю связь…', { ms: 0 });
    try {
      const api = new GitHubApi(this.store.cfg);
      const me = await api.whoami();
      const repo = await api.getRepo();
      t.remove();
      toast(`Связь есть. Аккаунт ${me.login}, репозиторий доступен (${repo.private ? 'приватный' : 'публичный'}).`);
    } catch (e) {
      t.remove();
      toast(e.message, { error: true, ms: 9000 });
    }
  }

  async forget() {
    if (!(await confirmDlg('Отключить синхронизацию?', 'Токен будет удалён с этого устройства. Данные в репозитории останутся на месте.', 'Отключить'))) return;
    saveCfg(null);
    localStorage.removeItem('fbr.cfg.v1');
    location.hash = '';
    location.reload();
  }
}

// ------------------------------------------------------------- первичная настройка

export function renderSetup(app, opts = {}) {
  const node = h('div.wrap', { style: { maxWidth: '46rem' } });
  const state = { owner: '', repo: '', branch: 'main', token: '' };
  const errorBox = h('div.notice.err', { style: { display: 'none', marginTop: '.8rem' } });
  if (app.error) { errorBox.textContent = app.error; errorBox.style.display = ''; app.error = null; }
  const showError = (msg) => { errorBox.textContent = msg; errorBox.style.display = ''; errorBox.scrollIntoView?.({ block: 'nearest' }); };

  const card = h('div.card');
  card.append(
    h('h2', 'Подключение хранилища'),
    h('p.hint',
      'Читалка хранит библиотеку и позиции чтения в вашем приватном репозитории GitHub. ',
      'Приложение при этом лежит на GitHub Pages — отдельный сервер не нужен.'),
    h('div.notice',
      h('div', { style: { marginBottom: '.4rem' } }, h('strong', 'Что нужно сделать один раз:')),
      h('ol', { style: { margin: '0 0 0 1.1rem', padding: 0, lineHeight: 1.6 } },
        h('li', 'Создайте приватный репозиторий, например ', h('code.mono', 'fb2-data'), ' — в нём будут лежать книги и прогресс.'),
        h('li', 'Создайте fine-grained token: ',
          h('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener' }, 'github.com/settings/personal-access-tokens/new')),
        h('li', 'В разделе Repository access выберите этот репозиторий, в Permissions → Repository permissions → Contents выставьте ', h('strong', 'Read and write'), '. Больше ничего не нужно.'),
        h('li', 'Скопируйте токен (он показывается один раз) и вставьте ниже.'),
      ),
    ),
  );

  const field = (label, key, attrs = {}) => h('label.field',
    h('span', label),
    h('input.input', { ...attrs, oninput: (e) => { state[key] = e.target.value.trim(); } }),
  );

  card.append(
    h('div', { style: { marginTop: '1rem' } },
      field('Владелец (ваш логин GitHub)', 'owner', { placeholder: 'username', autocomplete: 'off' }),
      field('Репозиторий для данных', 'repo', { placeholder: 'fb2-data', autocomplete: 'off' }),
      field('Ветка', 'branch', { placeholder: 'main', value: 'main', autocomplete: 'off' }),
      h('label.field', h('span', 'Токен (fine-grained, Contents: Read and write)'),
        h('div.row',
          h('input.input', {
            type: 'password', placeholder: 'github_pat_…', autocomplete: 'off', style: { flex: '1 1 16rem' },
            oninput: (e) => { state.token = e.target.value.trim(); },
          }),
          h('button.btn', { onclick: (e) => { const i = e.target.previousSibling; i.type = i.type === 'password' ? 'text' : 'password'; } }, 'Показать'),
        )),
    ),
    errorBox,
    h('div.row', { style: { marginTop: '.6rem' } },
      h('button.btn.primary', { onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        const old = btn.textContent;
        btn.textContent = 'Проверяю…';
        errorBox.style.display = 'none';
        try {
          validate(state);
          const cfg = { mode: 'github', owner: state.owner, repo: state.repo, branch: state.branch || 'main', token: state.token, api: DEFAULT_API };
          const api = new GitHubApi(cfg);
          await api.whoami();
          await api.getRepo();
          await app.connect(cfg);
          const link = shareLink({ ...cfg, branch: app.store.backend.branch || cfg.branch });
          app.rerender();
          toast('Подключено');
          showLinkModal(link);
        } catch (err) {
          showError(err && err.message ? err.message : String(err));
          btn.disabled = false;
          btn.textContent = old;
        }
      } }, 'Проверить и подключить'),
      h('button.btn', { onclick: async () => { await app.useLocalMode(); } }, 'Без синхронизации (только это устройство)'),
    ),
    h('div.hint', { style: { marginTop: '.8rem' } },
      'Токен хранится только в этом браузере. Если включить его в ссылку (кнопка появится после подключения), ',
      'её можно открыть на другом устройстве — там не придётся ничего вводить.'),
  );

  node.append(card);
  return node;
}

function validate(s) {
  if (!s.owner) throw new Error('Укажите владельца репозитория (ваш логин GitHub)');
  if (!/^[\w.-]+$/.test(s.owner)) throw new Error('Логин выглядит некорректно');
  if (!s.repo) throw new Error('Укажите имя репозитория');
  if (!/^[\w.-]+$/.test(s.repo)) throw new Error('Имя репозитория выглядит некорректно');
  if (!s.token) throw new Error('Вставьте токен доступа');
  if (s.token.length < 20) throw new Error('Токен слишком короткий — похоже, скопирован не полностью');
}

export function showLinkModal(link) {
  const box = h('div');
  const input = h('input.input.mono', { value: link, readonly: true });
  box.append(
    h('p.hint', 'Это ссылка на вашу читалку. Откройте её на телефоне или планшете — библиотека и позиция чтения появятся сами. В ссылке зашит токен: не выкладывайте её публично.'),
    input,
  );
  const m = modal({
    title: 'Ссылка для других устройств',
    body: box,
    actions: [{ label: 'Скопировать', primary: true, onClick: async () => { try { await navigator.clipboard.writeText(link); toast('Скопировано'); } catch { input.select(); } } }],
  });
  setTimeout(() => { input.focus(); input.select(); }, 50);
  return m;
}
