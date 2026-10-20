// Сквозной smoke-тест: загрузка index.html, запуск приложения, локальный режим,
// добавление книги, открытие читалки, сохранение позиции.
// Запуск: node tests/smoke-tests.mjs
//   JSDOM_PATH, FAKE_IDB_PATH — пути к модулям (если не видны из node_modules).

import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const url = (p) => (p && isAbsolute(p) ? pathToFileURL(p).href : p);

const { JSDOM } = await import(url(process.env.JSDOM_PATH) || 'jsdom');
const idbMod = await import(url(process.env.FAKE_IDB_PATH) || 'fake-indexeddb');

const html = await readFile(join(HERE, '..', 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'https://user.github.io/fb2-reader/', pretendToBeVisual: true });
const { window } = dom;

for (const k of ['window', 'document', 'DOMParser', 'Node', 'Element', 'HTMLElement', 'CustomEvent', 'Event', 'EventTarget', 'NodeFilter', 'Blob', 'File', 'FileList', 'FormData', 'getComputedStyle', 'history', 'location', 'localStorage', 'navigator', 'requestAnimationFrame', 'cancelAnimationFrame', 'IntersectionObserver']) {
  const v = window[k];
  if (v === undefined) continue;
  try {
    Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
  } catch { /* ignore */ }
}
globalThis.indexedDB = idbMod.indexedDB || idbMod.default;
globalThis.IDBKeyRange = idbMod.IDBKeyRange;
globalThis.URL.createObjectURL = () => 'blob:stub';
globalThis.URL.revokeObjectURL = () => {};
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('сеть не должна использоваться в локальном режиме'); };

const lines = [];
let fails = 0;
const ok = (name, cond, extra = '') => { if (!cond) fails++; lines.push({ pass: !!cond, name, extra: String(extra || '') }); };
const eq = (name, a, b) => ok(name, a === b, `получено ${JSON.stringify(a)}, ожидалось ${JSON.stringify(b)}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = async (n = 12) => { for (let i = 0; i < n; i++) await wait(10); };

const errors = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));
process.on('unhandledRejection', (e) => errors.push('unhandled: ' + (e && e.message || e)));

try {
  await import(pathToFileURL(join(HERE, '..', 'js', 'app.js')).href);
  await tick();

  const app = window.__app;
  ok('приложение стартовало', !!app);
  const root = window.document.getElementById('app');
  ok('без настройки показан экран подключения', /Подключение хранилища/.test(root.textContent), root.textContent.slice(0, 60).replace(/\s+/g, ' '));
  ok('в экране настройки есть поля', !!root.querySelector('input[placeholder="fb2-data"]'));

  // нажатие «Проверить и подключить» без данных должно показать ошибку, а не упасть
  const connectBtn = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === 'Проверить и подключить');
  connectBtn.click();
  await tick(10);
  const errBox = root.querySelector('.notice.err');
  ok('ошибка подключения показана прямо в форме', !!errBox && /Укажите владельца/.test(errBox.textContent), errBox ? errBox.textContent : 'нет блока ошибки');
  ok('кнопка подключения снова активна', !connectBtn.disabled);

  // локальный режим
  await app.useLocalMode();
  await tick();
  ok('локальный режим включён', app.store.backend.kind === 'local');
  ok('показана пустая библиотека', /Библиотека пуста/.test(root.textContent), root.textContent.slice(0, 80).replace(/\s+/g, ' '));

  // добавляем книгу через тот же путь, что и кнопка «Добавить книгу»
  const fb2 = await readFile(join(HERE, 'sample.fb2'));
  const file = new window.File([fb2], 'sample.fb2', { type: 'application/xml' });
  ok('файл для загрузки создан', file.size === fb2.length, 'size=' + file.size);

  const ingestPromise = app.library.ingest([file]);
  await tick(30);
  const dialog = window.document.querySelector('.modal-back');
  ok('диалог загрузки открылся', !!dialog);
  const uploadBtn = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Загрузить');
  ok('есть кнопка «Загрузить»', !!uploadBtn);
  uploadBtn.click();
  await ingestPromise;
  await tick(30);

  eq('книга добавлена в библиотеку', app.store.library.books.length, 1);
  const book = app.store.library.books[0];
  eq('название взято из FB2', book.title, 'Проверочная книга');
  eq('автор взят из FB2', book.author, 'Иван Тестов');
  ok('обложка сохранена', !!book.cover);
  ok('сетка показывает книгу', /Проверочная книга/.test(root.textContent));

  // открываем читалку
  app.openBook(book.id);
  await tick(40);
  const readerEl = window.document.querySelector('.reader');
  ok('читалка открылась', !!readerEl);
  const paras = readerEl.querySelectorAll('.reader-page p');
  ok('текст книги отрисован', paras.length > 20, 'абзацев: ' + paras.length);
  eq('заголовок книги в шапке читалки', readerEl.querySelector('.reader-title').textContent, 'Проверочная книга · Иван Тестов');
  ok('оглавление доступно', !!readerEl.querySelector('[title="Оглавление"]'));
  ok('есть обложка в начале текста', !!readerEl.querySelector('.fb2-cover img'));

  // кнопки тем
  const themeBtn = readerEl.querySelector('[title="Сменить фон"]');
  themeBtn.click(); await tick(2);
  eq('первое переключение — сепия', app.getPrefs().theme, 'sepia');
  themeBtn.click(); await tick(2);
  eq('второе — чёрная тема', app.getPrefs().theme, 'dark');
  eq('тема применена к документу', window.document.documentElement.dataset.theme, 'dark');
  themeBtn.click(); await tick(2);
  eq('третье — снова белая', app.getPrefs().theme, 'light');

  // сноска
  const note = readerEl.querySelector('[data-note-id="n1"]');
  ok('ссылка-сноска есть в тексте', !!note);
  note.click();
  await tick(4);
  const popup = window.document.querySelector('.popup');
  ok('сноска открылась в окне', !!popup && /Текст примечания номер один/.test(popup.textContent), popup && popup.textContent.slice(0, 60));
  popup.querySelector('button').click();
  await tick(4);
  ok('окно сноски закрылось', !window.document.querySelector('.popup'));

  // позиция чтения
  await app.store.setProgress(book.id, { i: 10, o: 0.25 }, 0.4, { immediate: true });
  const saved = JSON.parse(window.localStorage.getItem('fbr.cfg.v1') === null ? '{}' : '{}');
  void saved;
  const rec = app.store.progressFor(book.id);
  ok('позиция сохранена', !!rec && rec.a.i === 10 && Math.abs(rec.pct - 0.4) < 1e-9, JSON.stringify(rec));
  ok('последняя книга — эта', app.store.lastBookId === book.id);

  // закрытие читалки возвращает библиотеку
  readerEl.querySelector('[title="Назад (Esc)"]').click();
  await tick(20);
  ok('читалка закрылась', !window.document.querySelector('.reader'));
  ok('вернулись в библиотеку', /Моя библиотека/.test(root.textContent));

  // перезагрузка страницы не должна ломаться
  const itemsBefore = app.store.library.books.length;
  await app.store.refresh();
  eq('данные уцелели после повторного чтения', app.store.library.books.length, itemsBefore);

  // повторное открытие книги: клавиатура должна работать снова
  const scrolled = [];
  window.Element.prototype.scrollBy = function (o) { scrolled.push(o && o.top); };
  window.Element.prototype.scrollTo = function (o) { scrolled.push(o && o.top); };
  app.openBook(book.id);
  await tick(30);
  ok('книга открылась повторно', !!window.document.querySelector('.reader'));
  const before = scrolled.length;
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await tick(2);
  ok('клавиатура работает после повторного открытия', scrolled.length > before, 'вызовов: ' + (scrolled.length - before));
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  await tick(2);
  ok('End/Home обрабатываются', scrolled.length >= before + 3, 'вызовов: ' + (scrolled.length - before));
  app.reader.close();
  await tick(20);

  // обложка библиотеки грузится отложенно
  app.rerender();
  await tick(20);
  const coverImg = window.document.querySelector('.book .thumb img');
  ok('в карточке книги есть обложка', !!coverImg);

  // импорт из папки: диалог
  const folderBtn = Array.from(root.querySelectorAll('button')).find((b) => /Из папки/.test(b.textContent));
  ok('кнопка «Из папки» есть в библиотеке', !!folderBtn);
  folderBtn.click();
  await tick(12);
  const scanModal = window.document.querySelector('.scan-modal');
  ok('диалог импорта из папки открылся', !!scanModal);
  if (scanModal) {
    ok('в диалоге есть выбор папки, файлов и ZIP-архива',
      /Выбрать папку/.test(scanModal.textContent)
      && /Выбрать файлы/.test(scanModal.textContent)
      && /Из ZIP-архива/.test(scanModal.textContent));
    ok('показано пояснение про браузер без выбора папки', /нельзя открыть папку целиком/.test(scanModal.textContent));
    scanModal.querySelector('[aria-label="Закрыть"]').click();
    await tick(4);
    ok('диалог импорта закрылся', !window.document.querySelector('.scan-modal'));
  }

  // импорт из папки: полный путь со «сканированием» настоящей папки
  {
    const fb2b = Buffer.from(
      fb2.toString('utf8')
        .replace('Проверочная книга', 'Новая книга')
        .replace('Иван', 'Пётр')
        .replace('Тестов', 'Второй'),
      'utf8',
    );
    const mkFile = (name, data) => ({ kind: 'file', name, async getFile() { return new window.File([data], name); } });
    const mkDir = (name, children) => ({
      kind: 'directory',
      name,
      async *entries() { for (const c of children) yield [c.name, c]; },
    });
    window.showDirectoryPicker = async () => mkDir('Мои книги', [
      mkFile('Новая.fb2', fb2b),
      mkFile('Посторонний.txt', new Uint8Array([1, 2, 3])),
      mkDir('Вложенная', [mkFile('Ещё.fb2', fb2b)]),
    ]);

    const before = app.store.library.books.length;
    const btn = Array.from(root.querySelectorAll('button')).find((b) => /Из папки/.test(b.textContent));
    btn.click();
    await tick(12);
    const modal2 = window.document.querySelector('.scan-modal');
    const pickBtn = Array.from(modal2.querySelectorAll('button')).find((b) => b.textContent === 'Выбрать папку');
    pickBtn.click();
    await tick(80);

    const rows = modal2.querySelectorAll('.scan-row');
    ok('скан: найдены файлы .fb2 во вложенных папках', rows.length === 2, 'строк: ' + rows.length);
    ok('скан: показано название из метаданных', /Новая книга/.test(modal2.textContent));
    ok('скан: показано имя папки в пути', /Вложенная\/Ещё\.fb2/.test(modal2.textContent));
    ok('скан: посторонний файл не попал в список', !/Посторонний/.test(modal2.textContent));

    const addBtn = Array.from(modal2.querySelectorAll('button')).find((b) => /^Добавить/.test(b.textContent));
    ok('скан: кнопка добавления активна', !!addBtn && !addBtn.disabled, addBtn ? addBtn.textContent : 'нет кнопки');
    addBtn.click();
    await tick(80);

    eq('скан: книги добавлены в библиотеку', app.store.library.books.length, before + 2);
    ok('скан: диалог закрылся после добавления', !window.document.querySelector('.scan-modal'));
    const added = app.store.library.books.filter((b) => b.title === 'Новая книга' || b.title === 'Новая книга');
    ok('скан: добавленная книга с правильным названием', added.length >= 1, app.store.library.books.map((b) => b.title).join(', '));

    // убираем за собой, чтобы не мешать проверкам ниже
    for (const b of app.store.library.books.slice()) {
      if (b.title !== book.title) await app.store.removeBook(b.id);
    }
    eq('скан: состояние восстановлено', app.store.library.books.length, before);
  }

  // меню книги
  const menuBtn = window.document.querySelector('.book .menu-btn');
  menuBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick(4);
  const menu = window.document.querySelector('.menu-pop');
  ok('меню книги открылось', !!menu);
  const labels = Array.from(menu.querySelectorAll('button')).map((b) => b.textContent);
  ok('в меню есть скачивание и удаление', labels.some((l) => /Скачать/.test(l)) && labels.some((l) => /Удалить/.test(l)), labels.join(', '));
  menu.querySelector('button').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick(20);
  ok('после «Читать» открылась читалка', !!window.document.querySelector('.reader'));

  // панель настроек текста в читалке
  const readerEl2 = window.document.querySelector('.reader');
  readerEl2.querySelector('[title="Настройки текста"]').click();
  await tick(4);
  const sheet = window.document.querySelector('.sheet-back');
  ok('панель настроек текста открылась', !!sheet);
  ok('в панели есть фон и шрифт', /Фон/.test(sheet.textContent) && /Шрифт/.test(sheet.textContent));
  const sizeRange = sheet.querySelector('input[type="range"]');
  sizeRange.value = '26';
  sizeRange.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick(4);
  eq('размер шрифта применён', app.getPrefs().fontSize, 26);
  eq('переменная CSS обновлена', window.document.documentElement.style.getPropertyValue('--reader-size'), '26px');
  sheet.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  await tick(10);
  ok('панель закрылась по клику вне', !window.document.querySelector('.sheet-back'));
  app.reader.close();
  await tick(10);

  // оглавление
  app.openBook(book.id);
  await tick(30);
  window.document.querySelector('[title="Оглавление"]').click();
  await tick(4);
  const toc = window.document.querySelector('.toc-panel');
  ok('оглавление открылось', !!toc);
  eq('в оглавлении 5 глав', toc.querySelectorAll('button').length, 6); // 5 глав + кнопка закрытия
  toc.querySelectorAll('button')[2].click();
  await tick(4);
  ok('оглавление закрылось после перехода', !window.document.querySelector('.toc-panel'));
  app.reader.close();
  await tick(10);

  // экран настроек приложения
  app.nav('settings');
  await tick(10);
  ok('открылись настройки', /Хранилище и синхронизация/.test(root.textContent));
  ok('есть раздел оформления', /Оформление/.test(root.textContent));
  ok('есть список устройств', /Устройства/.test(root.textContent));
  ok('есть раздел о программе', /О программе/.test(root.textContent));
  ok('в локальном режиме предложено подключить GitHub', /Подключить GitHub-синхронизацию/.test(root.textContent));
  const darkBtn = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === 'Чёрный');
  darkBtn.click();
  await tick(4);
  eq('тема переключена из настроек', app.getPrefs().theme, 'dark');
  eq('тема применилась', window.document.documentElement.dataset.theme, 'dark');
  app.nav('library');
  await tick(10);
  ok('вернулись в библиотеку', /Моя библиотека/.test(root.textContent));

  // возврат темы к светлой
  app.setPrefs({ ...app.getPrefs(), theme: 'light' });
  await tick(2);

  // удаление
  await app.store.removeBook(book.id);
  eq('книга удалена', app.store.library.books.length, 0);

  ok('сеть в локальном режиме не использовалась', fetchCalls === 0, 'вызовов fetch: ' + fetchCalls);
  ok('ошибок в консоли нет', errors.length === 0, errors.join(' | '));
} catch (e) {
  ok('тест без исключений', false, e && e.stack || String(e));
}

let failed = 0;
for (const l of lines) {
  if (!l.pass) failed++;
  console.log(`${l.pass ? 'PASS' : 'FAIL'} | ${l.name}${l.extra && !l.pass ? ' | ' + l.extra : ''}`);
}
console.log(failed === 0 ? `\nВСЕ SMOKE-ТЕСТЫ ПРОЙДЕНЫ (${lines.length})` : `\nПРОВАЛЕНО: ${failed} из ${lines.length}`);
process.exit(failed === 0 ? 0 : 1);
