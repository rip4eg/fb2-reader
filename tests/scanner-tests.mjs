// Тесты сканера папок: обход каталогов, отбор .fb2, чтение метаданных.
// Запуск: node tests/scanner-tests.mjs
import { readFile } from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

const {
  isCandidateName, isBookName, isZipName, metaFromText, peekMeta,
  walkDirectory, scanSource, markExisting, mapLimit, scanArchive, scanDataTransfer,
} = await import('../js/scanner.js');

const lines = [];
let fails = 0;
const ok = (name, cond, extra = '') => { if (!cond) fails++; lines.push({ pass: !!cond, name, extra: String(extra || '') }); };
const eq = (name, a, b) => ok(name, a === b, `получено ${JSON.stringify(a)}, ожидалось ${JSON.stringify(b)}`);

const fb2Bytes = await readFile(join(HERE, 'sample.fb2'));
const zipBytes = await readFile(join(HERE, 'sample.fb2.zip'));

// ---------- имена ----------
ok('.fb2 — кандидат', isCandidateName('Книга.fb2'));
ok('.FB2 в верхнем регистре — кандидат', isCandidateName('КНИГА.FB2'));
ok('.fb2.zip — кандидат', isCandidateName('Книга.fb2.zip'));
ok('.zip — кандидат (проверим содержимое позже)', isCandidateName('архив.zip'));
ok('.txt — не кандидат', !isCandidateName('заметки.txt'));
ok('.fb2 — это книга', isBookName('a.fb2') && isBookName('a.fb2.zip'));
ok('.zip — это архив', isZipName('a.zip') && !isZipName('a.fb2'));

// ---------- метаданные из обрезанного начала файла ----------
{
  const head = fb2Bytes.subarray(0, 4096);
  const text = new TextDecoder('utf-8').decode(head);
  const meta = metaFromText(text);
  eq('metaFromText: название из начала файла', meta.title, 'Проверочная книга');
  eq('metaFromText: автор из начала файла', meta.author, 'Иван Тестов');
  eq('metaFromText: серия', meta.sequence, 'Серия тестов #3');
  eq('metaFromText: язык', meta.lang, 'ru');
}

// ---------- peekMeta на настоящих файлах ----------
{
  const fb2File = new File([fb2Bytes], 'Проверочная книга.fb2');
  const meta = await peekMeta(fb2File);
  ok('peekMeta .fb2: прочитано', meta.ok, JSON.stringify(meta));
  eq('peekMeta .fb2: название', meta.title, 'Проверочная книга');

  const zipFile = new File([zipBytes], 'Книга.fb2.zip');
  const zmeta = await peekMeta(zipFile);
  ok('peekMeta .fb2.zip: прочитано', zmeta.ok, JSON.stringify(zmeta));
  eq('peekMeta .fb2.zip: название', zmeta.title, 'Проверочная книга');

  const fakeZip = new File([new TextEncoder().encode('это просто текст')], 'подделка.zip');
  const fmeta = await peekMeta(fakeZip);
  ok('peekMeta: поддельный zip отклонён', !fmeta.ok && /ZIP/i.test(fmeta.error), JSON.stringify(fmeta));

  const fakeFb2 = new File([new TextEncoder().encode('просто текст, не FB2')], 'подделка.fb2');
  const gmeta = await peekMeta(fakeFb2);
  ok('peekMeta: не-FB2 отклонён', !gmeta.ok, JSON.stringify(gmeta));
}

// ---------- обход каталога ----------
function fileHandle(name, data) {
  return { kind: 'file', name, async getFile() { return new File([data], name); } };
}
function dirHandle(name, children) {
  return {
    kind: 'directory',
    name,
    async *entries() { for (const c of children) yield [c.name, c]; },
  };
}

{
  const tree = dirHandle('Библиотека', [
    fileHandle('Первая.fb2', fb2Bytes),
    fileHandle('.скрытая.fb2', fb2Bytes),
    fileHandle('заметки.txt', new Uint8Array([1, 2, 3])),
    dirHandle('Подпапка', [
      fileHandle('Вторая.FB2', fb2Bytes),
      dirHandle('Глубоко', [
        fileHandle('Третья.fb2.zip', zipBytes),
        fileHandle('картинка.png', new Uint8Array([4, 5])),
      ]),
    ]),
  ]);

  const acc = { seen: 0, entries: [] };
  await walkDirectory(tree, '', acc, 0);
  eq('обход: найдено 3 книги', acc.entries.length, 3);
  const paths = acc.entries.map((e) => e.path).sort();
  eq('обход: пути с подпапками', JSON.stringify(paths), JSON.stringify([
    'Первая.fb2', 'Подпапка/Вторая.FB2', 'Подпапка/Глубоко/Третья.fb2.zip',
  ]));
  ok('обход: скрытые файлы пропущены', !paths.some((p) => p.includes('.скрытая')));
  ok('обход: ненужные расширения не попали в список', !paths.some((p) => /\.(txt|png)$/i.test(p)));

  const res = await scanSource({ kind: 'handle', handle: tree, name: 'Библиотека' });
  eq('scanSource(handle): книг', res.entries.length, 3);
  ok('scanSource: файлы доступны для чтения', res.entries.every((e) => e.file && typeof e.file.arrayBuffer === 'function'));
}

// ---------- scanSource для списка файлов ----------
{
  const files = [
    new File([fb2Bytes], 'a.fb2'),
    new File([new Uint8Array([1])], 'b.txt'),
    new File([zipBytes], 'c.fb2.zip'),
  ];
  files[0].webkitRelativePath = 'Books/автор/a.fb2';
  const res = await scanSource({ kind: 'files', files, name: 'Файлы' });
  eq('scanSource(files): только книги', res.entries.length, 2);
  eq('scanSource(files): путь из webkitRelativePath', res.entries.find((e) => e.name === 'a.fb2').path, 'Books/автор/a.fb2');
}

// ---------- пометка «уже в библиотеке» ----------
{
  const books = [{ title: 'Проверочная книга', author: 'Иван Тестов', size: 999999 }];
  const entries = [
    { path: 'x/1.fb2', size: 123, meta: { ok: true, title: 'Проверочная книга', author: 'Иван Тестов' } },
    { path: 'x/2.fb2', size: 999999, meta: { ok: true, title: 'Другое', author: 'Кто-то' } },
    { path: 'x/3.fb2', size: 42, meta: { ok: true, title: 'Новая', author: 'Автор' } },
  ];
  const marked = markExisting(entries, books);
  ok('помечена книга с тем же названием и автором', marked[0].existing);
  ok('помечена книга с тем же размером', marked[1].existing);
  ok('новая книга не помечена', !marked[2].existing);
}

// ---------- mapLimit ----------
{
  let active = 0;
  let maxActive = 0;
  const order = [];
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    order.push(n);
    return n * 2;
  });
  eq('mapLimit: порядок результатов сохранён', JSON.stringify(out), JSON.stringify([2, 4, 6, 8, 10, 12, 14]));
  ok('mapLimit: параллельность не выше лимита', maxActive <= 3, 'максимум одновременно: ' + maxActive);
  eq('mapLimit: обработаны все', order.length, 7);
}

// ---------- книги внутри ZIP-архива ----------
{
  const archiveBytes = await readFile(join(HERE, 'collection.zip'));
  const archive = new File([archiveBytes], 'Мои книги.zip');
  const res = await scanArchive(archive);
  eq('архив: найдено 3 книги из 5 записей', res.entries.length, 3);
  eq('архив: всего записей просмотрено', res.seen, 5);
  const titles = res.entries.map((e) => e.meta.title).sort();
  ok('архив: названия прочитаны', titles.includes('Проверочная книга') && titles.includes('Вторая книга архива'), titles.join(' | '));
  ok('архив: книга в windows-1251 внутри архива читается', titles.includes('Проверочная книга'));
  ok('архив: не-FB2 файлы в списке отсутствуют', !res.entries.some((e) => /\.(txt|png)$/i.test(e.name)));
  ok('архив: путь включает имя архива и путь внутри', res.entries.some((e) => /^Мои книги\.zip \/ Книги\/.+\.fb2$/.test(e.path)), res.entries.map((e) => e.path).join(' | '));
  ok('архив: каждая книга готова к добавлению', res.entries.every((e) => e.file && typeof e.file.arrayBuffer === 'function'));

  const single = await scanArchive(new File([zipBytes], 'one.zip'));
  eq('архив с одной книгой', single.entries.length, 1);

  let threw = null;
  try { await scanArchive(new File([new TextEncoder().encode('не архив')], 'fake.zip')); } catch (e) { threw = e; }
  ok('архив: недопустимый файл отклонён', !!threw && /ZIP/i.test(threw.message), threw && threw.message);
}

// ---------- перетаскивание папки в окно ----------
{
  const mkFileEntry = (name, data) => ({
    isFile: true,
    isDirectory: false,
    name,
    file(cb) { cb(new File([data], name)); },
  });
  const mkDirEntry = (name, children) => ({
    isFile: false,
    isDirectory: true,
    name,
    createReader() {
      let call = 0;
      return {
        readEntries(cb) {
          // как в браузере: сначала порция, потом пусто
          const batch = call === 0 ? children : [];
          call++;
          cb(batch);
        },
      };
    },
  });

  const root = mkDirEntry('books', [
    mkFileEntry('Первая.fb2', fb2Bytes),
    mkFileEntry('заметки.txt', new Uint8Array([1])),
    mkDirEntry('вложенная', [
      mkFileEntry('Вторая.fb2', fb2Bytes),
      mkDirEntry('глубоко', [mkFileEntry('Третья.fb2', fb2Bytes)]),
    ]),
  ]);

  const res = await scanDataTransfer({ items: [{ webkitGetAsEntry: () => root }], files: [] });
  eq('перетаскивание: найдено 3 книги', res.entries.length, 3);
  ok('перетаскивание: путь от имени папки', res.entries.some((e) => e.path === 'books/вложенная/глубоко/Третья.fb2'),
    res.entries.map((e) => e.path).join(' | '));
  ok('перетаскивание: .txt отброшен', !res.entries.some((e) => /\.txt$/.test(e.name)));

  // браузер без webkitGetAsEntry — работаем через dt.files
  const plain = await scanDataTransfer({ items: [], files: [new File([fb2Bytes], 'x.fb2'), new File([new Uint8Array([1])], 'y.txt')] });
  eq('перетаскивание файлов без entries', plain.entries.length, 1);
  eq('перетаскивание файлов: имя сохранено', plain.entries[0].name, 'x.fb2');
}

// ---------- итог ----------
function finish() {
  let failed = 0;
  const out = [];
  for (const l of lines) {
    if (!l.pass) failed++;
    out.push(`${l.pass ? 'PASS' : 'FAIL'} | ${l.name}${l.extra && !l.pass ? ' | ' + l.extra : ''}`);
  }
  out.push(failed === 0 ? `\nВСЕ ТЕСТЫ СКАНЕРА ПРОЙДЕНЫ (${lines.length})` : `\nПРОВАЛЕНО: ${failed} из ${lines.length}`);
  const text = out.join('\n') + '\n';
  try { writeSync(1, text); } catch { console.log(text); }
  process.exit(failed === 0 ? 0 : 1);
}
finish();
