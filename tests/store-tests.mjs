// Интеграционный тест хранилища: библиотека, прогресс, синхронизация двух устройств.
// Запуск: node tests/store-tests.mjs

import { readFile } from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';
import { MockGitHub } from './mock-github.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// IndexedDB обязателен: без него кэш молча отключается и баги кэша не видны.
const idbTarget = process.env.FAKE_IDB_PATH
  ? (isAbsolute(process.env.FAKE_IDB_PATH) ? pathToFileURL(process.env.FAKE_IDB_PATH).href : process.env.FAKE_IDB_PATH)
  : 'fake-indexeddb';
const idbMod = await import(idbTarget).catch(() => null);
if (idbMod) {
  globalThis.indexedDB = idbMod.indexedDB || idbMod.default;
  globalThis.IDBKeyRange = idbMod.IDBKeyRange;
}

// ---- минимальные браузерные глобали ----
class MemStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
const store = new MemStorage();
globalThis.localStorage = store;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120', platform: 'Win32', storage: null },
});
globalThis.URL.createObjectURL = () => 'blob:stub';
globalThis.URL.revokeObjectURL = () => {};

const { Store } = await import('../js/store.js');
const { idb } = await import('../js/util.js');

const lines = [];
let fails = 0;
const ok = (name, cond, extra = '') => { if (!cond) fails++; lines.push({ pass: !!cond, name, extra: String(extra || '') }); };
const describe = (v) => {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  try { return JSON.stringify(v); } catch { return Object.prototype.toString.call(v) + ' (' + (v.constructor && v.constructor.name) + ')'; }
};
const eq = (name, a, b) => ok(name, a === b, `получено ${describe(a)}, ожидалось ${describe(b)}`);

const mock = new MockGitHub();
globalThis.fetch = (url, init) => mock.fetch(url, init);
const cfg = { mode: 'github', owner: 'user', repo: 'fb2-data', branch: 'main', token: 'github_pat_test', api: 'https://api.github.com' };

const fb2 = await readFile(join(HERE, 'sample.fb2'));

// ---------- кэш файлов (регрессия: промах кэша возвращал объект IDBRequest) ----------
ok('IndexedDB доступен в тестах', typeof indexedDB !== 'undefined', idbMod ? 'fake-indexeddb' : 'модуль не найден — тест кэша пропущен');
if (idbMod) {
  const miss = await idb.get('нет-такого-ключа');
  ok('idb: промах кэша даёт undefined, а не объект запроса', miss === undefined, 'получено ' + describe(miss));
  await idb.put('проверка', 'значение');
  eq('idb: запись читается обратно', await idb.get('проверка'), 'значение');
  const buf = new Uint8Array([1, 2, 3, 250]);
  await idb.put('буфер', buf.buffer.slice(0));
  const got = await idb.get('буфер');
  ok('idb: ArrayBuffer читается обратно', got instanceof ArrayBuffer && new Uint8Array(got)[3] === 250, got && got.constructor && got.constructor.name);
  const keys = await idb.keys();
  ok('idb: список ключей работает', Array.isArray(keys) && keys.includes('буфер'), JSON.stringify(keys));
  await idb.del('проверка');
  eq('idb: удаление работает', await idb.get('проверка'), undefined);
}

// ---------- устройство 1 ----------
store.setItem('fbr.device.v1', JSON.stringify({ id: 'dev1', name: 'Ноутбук' }));
const s1 = new Store();
await s1.connect(cfg);
await s1.refresh();
eq('пустая библиотека инициализирована', s1.library.books.length, 0);
ok('library.json создан в репозитории', mock.files.has('library.json'));

await s1.addBooks([
  { name: 'sample.fb2', size: fb2.length, buffer: fb2.buffer.slice(fb2.byteOffset, fb2.byteOffset + fb2.byteLength), meta: { title: 'Проверочная книга', author: 'Иван Тестов' }, coverBlob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }) },
  { name: 'second.fb2', size: 10, buffer: new Uint8Array([60, 120, 47, 62]).buffer, meta: { title: 'Вторая книга', author: 'Автор' }, coverBlob: null },
]);
eq('добавлено две книги', s1.library.books.length, 2);
ok('файлы книг в репозитории', mock.files.has(s1.library.books[0].file) && mock.files.has(s1.library.books[1].file));
ok('обложка сохранена отдельным файлом', !!s1.library.books[0].cover && mock.files.has(s1.library.books[0].cover));
ok('библиотека в репозитории обновлена', JSON.parse(Buffer.from(mock.files.get('library.json'), 'base64').toString('utf8')).books.length === 2);

const book1 = s1.library.books[0];
const got = new Uint8Array(await s1.getBookBytes(book1));
ok('файл книги читается байт-в-байт', got.length === fb2.length && got[10] === fb2[10] && got[fb2.length - 1] === fb2[fb2.length - 1]);

// имитация перезагрузки страницы: новый Store, тот же IndexedDB, то же устройство.
// Именно здесь раньше библиотека «терялась» из-за промаха кэша.
store.setItem('fbr.device.v1', JSON.stringify({ id: 'dev1', name: 'Ноутбук' }));
const sReload = new Store();
await sReload.connect(cfg);
await sReload.refresh();
eq('после перезагрузки страницы библиотека на месте', sReload.library.books.length, 2);
const rb = sReload.library.books[0];
ok('после перезагрузки есть книга для чтения', !!rb);
if (rb) {
  const gotReload = new Uint8Array(await sReload.getBookBytes(rb));
  ok('после перезагрузки файл книги читается байт-в-байт', gotReload.length === fb2.length && gotReload[10] === fb2[10], `получено ${gotReload.length} байт вместо ${fb2.length}`);
}

await s1.setProgress(book1.id, { i: 12, o: 0.5 }, 0.33, { immediate: true });
ok('файл прогресса устройства создан', mock.files.has('progress/dev1.json'));
const p1 = JSON.parse(Buffer.from(mock.files.get('progress/dev1.json'), 'base64').toString('utf8'));
ok('прогресс записан верно', p1.books[book1.id].a.i === 12 && Math.abs(p1.books[book1.id].pct - 0.33) < 1e-9, JSON.stringify(p1.books[book1.id]));

// ---------- устройство 2 ----------
store.setItem('fbr.device.v1', JSON.stringify({ id: 'dev2', name: 'Телефон' }));
const s2 = new Store();
await s2.connect(cfg);
await s2.refresh();
eq('второе устройство видит обе книги', s2.library.books.length, 2);
const rec2 = s2.progressFor(book1.id);
ok('второе устройство получило позицию первого', !!rec2 && rec2.a.i === 12 && rec2.deviceName === 'Ноутбук', JSON.stringify(rec2 && rec2.deviceName));
eq('lastBookId указывает на книгу с прогрессом', s2.lastBookId, book1.id);
ok('статистика учитывает прогресс', s2.stats().inProgress === 1, JSON.stringify(s2.stats()));

// второе устройство читает дальше — позиция новее
await new Promise((r) => setTimeout(r, 5));
await s2.setProgress(book1.id, { i: 40, o: 0.1 }, 0.7, { immediate: true });
await s2.refresh();
const rec2b = s2.progressFor(book1.id);
eq('второе устройство видит свою свежую позицию', rec2b.a.i, 40);

// первое устройство подтягивает
await s1.refresh();
const rec1 = s1.progressFor(book1.id);
eq('первое устройство увидело позицию второго', rec1.a.i, 40);
eq('источник позиции — второе устройство', rec1.deviceId, 'dev2');
eq('устройств в списке два', s1.devices().length, 2);

// старый прогресс не перебивает новый
await s1.setProgress(book1.id, { i: 1, o: 0 }, 0.01, { immediate: true });
await new Promise((r) => setTimeout(r, 5));
await s2.setProgress(book1.id, { i: 55, o: 0 }, 0.9, { immediate: true });
await s1.refresh();
eq('берётся самая свежая запись', s1.progressFor(book1.id).a.i, 55);

// ---------- конфликт ветки ----------
mock.failNextPatch = 1;
let conflictOk = true;
try {
  await s1.setProgress(book1.id, { i: 60, o: 0 }, 0.95, { immediate: true });
} catch { conflictOk = false; }
ok('коммит повторяется после конфликта ветки', conflictOk);

// ---------- удаление ----------
const coverPath = book1.cover;
const filePath = book1.file;
await s1.removeBook(book1.id);
eq('книга удалена из библиотеки', s1.library.books.length, 1);
ok('файл книги удалён из репозитория', !mock.files.has(filePath));
ok('обложка удалена из репозитория', !mock.files.has(coverPath));
await s2.refresh();
eq('второе устройство увидело удаление', s2.library.books.length, 1);
ok('прогресс удалённой книги игнорируется', s2.progressFor(book1.id) === null || !s2.library.books.some((b) => b.id === book1.id));

// ---------- правка метаданных ----------
const only = s1.library.books[0];
await s1.updateBookMeta(only.id, { title: 'Новое название' });
eq('название изменено', s1.library.books[0].title, 'Новое название');
await s2.refresh();
eq('изменение видно на втором устройстве', s2.library.books[0].title, 'Новое название');

// ---------- сохранение во время чтения (регрессия: таймер переносился при каждом изменении) ----------
{
  store.setItem('fbr.device.v1', JSON.stringify({ id: 'dev-reading', name: 'Читаю непрерывно' }));
  const s = new Store();
  s.pushDelayMs = 200; // ускоряем для теста: задержка отправки
  await s.connect(cfg);
  await s.refresh();
  const b = s.library.books[0];

  let savedWhileReading = false;
  for (let i = 0; i < 40; i++) {
    await s.setProgress(b.id, { i: 100 + i * 5, o: 0.5 }, 0.1 + i / 100);
    await new Promise((r) => setTimeout(r, 40));
    if (!savedWhileReading && mock.files.has('progress/dev-reading.json')) savedWhileReading = true;
  }
  ok('позиция уходит в репозиторий во время чтения, а не только после остановки', savedWhileReading);
  const rawReading = mock.files.get('progress/dev-reading.json');
  const saved = rawReading ? JSON.parse(Buffer.from(rawReading, 'base64').toString('utf8')) : null;
  ok('сохранённая позиция не «нулевая»', !!(saved && saved.books[b.id] && saved.books[b.id].a.i > 100), saved ? JSON.stringify(saved.books[b.id]) : 'файл прогресса не создан');

  // обновление из репозитория не должно затирать несохранённые записи
  await s.setProgress(b.id, { i: 7777, o: 0.9 }, 0.8);
  const before = s.me.books[b.id] ? s.me.books[b.id].a.i : null;
  await s.refresh();
  eq('несохранённая позиция переживает обновление из репозитория', s.me.books[b.id] && s.me.books[b.id].a.i, before);
}
mock.denied = true;
const s3 = new Store();
store.setItem('fbr.device.v1', JSON.stringify({ id: 'dev3', name: 'Планшет' }));
let denied = null;
try { await s3.connect(cfg); await s3.refresh(); } catch (e) { denied = e; }
ok('недоступный репозиторий даёт понятную ошибку', !!denied && /404|доступ/i.test(denied.message), denied && denied.message);
mock.denied = false;

// ---------- итог ----------
function finish() {
  let failed = 0;
  const out = [];
  for (const l of lines) {
    if (!l.pass) failed++;
    out.push(`${l.pass ? 'PASS' : 'FAIL'} | ${l.name}${l.extra && !l.pass ? ' | ' + l.extra : ''}`);
  }
  out.push(failed === 0 ? `\nВСЕ ТЕСТЫ ХРАНИЛИЩА ПРОЙДЕНЫ (${lines.length})` : `\nПРОВАЛЕНО: ${failed} из ${lines.length}`);
  const text = out.join('\n') + '\n';
  // пишем синхронно: при перенаправлении вывода process.exit() теряет незаписанное
  try { writeSync(1, text); } catch { console.log(text); }
  process.exit(failed === 0 ? 0 : 1);
}

// падение внутри теста должно выглядеть как обычный провал, а не как стектрейс
process.on('uncaughtException', (e) => { ok('набор тестов выполнился без падения', false, e && e.message); finish(); });
process.on('unhandledRejection', (e) => { ok('набор тестов выполнился без падения', false, (e && e.message) || String(e)); finish(); });

finish();
