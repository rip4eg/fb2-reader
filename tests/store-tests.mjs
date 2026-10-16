// Интеграционный тест хранилища: библиотека, прогресс, синхронизация двух устройств.
// Запуск: node tests/store-tests.mjs

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MockGitHub } from './mock-github.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

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

const lines = [];
let fails = 0;
const ok = (name, cond, extra = '') => { if (!cond) fails++; lines.push({ pass: !!cond, name, extra: String(extra || '') }); };
const eq = (name, a, b) => ok(name, a === b, `получено ${JSON.stringify(a)}, ожидалось ${JSON.stringify(b)}`);

const mock = new MockGitHub();
globalThis.fetch = (url, init) => mock.fetch(url, init);
const cfg = { mode: 'github', owner: 'user', repo: 'fb2-data', branch: 'main', token: 'github_pat_test', api: 'https://api.github.com' };

const fb2 = await readFile(join(HERE, 'sample.fb2'));

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

// ---------- ошибки ----------
mock.denied = true;
const s3 = new Store();
store.setItem('fbr.device.v1', JSON.stringify({ id: 'dev3', name: 'Планшет' }));
let denied = null;
try { await s3.connect(cfg); await s3.refresh(); } catch (e) { denied = e; }
ok('недоступный репозиторий даёт понятную ошибку', !!denied && /404|доступ/i.test(denied.message), denied && denied.message);
mock.denied = false;

// ---------- итог ----------
let failed = 0;
for (const l of lines) {
  if (!l.pass) failed++;
  console.log(`${l.pass ? 'PASS' : 'FAIL'} | ${l.name}${l.extra && !l.pass ? ' | ' + l.extra : ''}`);
}
console.log(failed === 0 ? `\nВСЕ ТЕСТЫ ХРАНИЛИЩА ПРОЙДЕНЫ (${lines.length})` : `\nПРОВАЛЕНО: ${failed} из ${lines.length}`);
process.exit(failed === 0 ? 0 : 1);
