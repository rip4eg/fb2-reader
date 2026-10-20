// Единый набор проверок. Запускается и в браузере (tests/run.html),
// и в Node через jsdom (tests/node-tests.mjs).
//
// env = {
//   readBytes(path) -> ArrayBuffer,
//   readText(path)  -> string,
//   prepareLayout(scrollEl, pageEl, blocks) -> {setFontScale(k)}
// }

import { b64ToBytes, bytesToB64, b64urlEncode, b64urlDecode, clamp } from '../js/util.js';
import { isZip, zipEntries, unzipFirstFb2 } from '../js/zip.js';
import { parseFb2, decodeXmlBuffer, fb2TextFromBuffer, BLOCK_SELECTOR } from '../js/fb2.js';
import { indexBlocks, anchorAt, applyAnchor, percentAt } from '../js/position.js';
import { encodeCfg, decodeCfg } from '../js/config.js';

export async function runSuite(env) {
  const lines = [];
  let fails = 0;
  const ok = (name, cond, extra = '') => {
    if (!cond) fails++;
    lines.push({ pass: !!cond, name, extra: extra ? String(extra) : '' });
  };
  const eq = (name, actual, expected) => ok(name, actual === expected, `получено ${JSON.stringify(actual)}, ожидалось ${JSON.stringify(expected)}`);

  // ---------- base64 ----------
  const bytes = new Uint8Array(70000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
  const back = b64ToBytes(bytesToB64(bytes));
  ok('base64: длинный буфер обрабатывается', back.length === bytes.length && back[65000] === bytes[65000]);
  eq('base64url round-trip', b64urlDecode(b64urlEncode('привет=+/мир')), 'привет=+/мир');
  eq('clamp', clamp(5, 0, 3), 3);

  // ---------- zip ----------
  const zipBuf = await env.readBytes('sample.fb2.zip');
  ok('isZip определяет .fb2.zip', isZip(zipBuf));
  const entries = zipEntries(zipBuf);
  ok('zip: найдена запись .fb2', entries.length === 1 && /\.fb2$/.test(entries[0].name), JSON.stringify(entries.map((e) => e.name)));
  const un = await unzipFirstFb2(zipBuf);
  const unText = decodeXmlBuffer(un.data);
  ok('zip(deflate): текст книги распакован', unText.includes('Проверочная книга') && unText.includes('Глава 5'));
  const stored = await unzipFirstFb2(await env.readBytes('sample-stored.zip'));
  ok('zip(stored): текст книги распакован', decodeXmlBuffer(stored.data).includes('Проверочная книга'));

  // ---------- кодировки ----------
  const text1251 = decodeXmlBuffer(await env.readBytes('sample1251.fb2'));
  ok('windows-1251 распознана', text1251.includes('Проверочная книга') && !text1251.includes('\uFFFD'), text1251.slice(0, 40));

  // Регрессия: корректный UTF-8, у которого 500-й байт — начало символа,
  // то есть срез [0:500] обрывается на середине последовательности.
  const cutBuf = await env.readBytes('cut-utf8.fb2');
  const cutByte = new Uint8Array(cutBuf)[499];
  ok('фикстура: 500-й байт — начало многобайтового символа', cutByte >= 0xC2 && cutByte <= 0xDF, '0x' + cutByte.toString(16));
  const cutText = decodeXmlBuffer(cutBuf);
  ok('UTF-8 с обрывом на 500-м байте читается как UTF-8', cutText.includes('Проверочная книга') && !cutText.includes('\uFFFD'), JSON.stringify(cutText.slice(0, 60)));
  eq('название из UTF-8 с обрывом', parseFb2(cutText).meta.title, 'Проверочная книга');

  // Содержимое в UTF-8, а в декларации указана windows-1251.
  const wrongDecl = decodeXmlBuffer(await env.readBytes('wrong-decl.fb2'));
  ok('UTF-8 с неверной декларацией 1251 читается как UTF-8', wrongDecl.includes('Проверочная книга'), JSON.stringify(wrongDecl.slice(0, 70)));
  eq('название при неверной декларации', parseFb2(wrongDecl).meta.title, 'Проверочная книга');

  // windows-1251 без XML-декларации.
  const noDecl = decodeXmlBuffer(await env.readBytes('nodecl-1251.fb2'));
  ok('windows-1251 без декларации распознана', noDecl.includes('Проверочная книга'), JSON.stringify(noDecl.slice(0, 50)));

  // UTF-8 с BOM.
  const bomText = decodeXmlBuffer(await env.readBytes('bom-utf8.fb2'));
  ok('UTF-8 с BOM: BOM отброшен', bomText.trimStart().startsWith('<?xml'), JSON.stringify(bomText.slice(0, 20)));
  eq('название из файла с BOM', parseFb2(bomText).meta.title, 'Проверочная книга');

  const viaZip = await fb2TextFromBuffer(zipBuf);
  ok('fb2TextFromBuffer: zip распознан', viaZip.text.includes('Проверочная книга') && viaZip.innerName.endsWith('.fb2'));

  // ---------- парсер ----------
  const text = await env.readText('sample.fb2');
  const book = parseFb2(text);
  eq('meta.title', book.meta.title, 'Проверочная книга');
  eq('meta.author', book.meta.author, 'Иван Тестов');
  eq('meta.sequence', book.meta.sequence, 'Серия тестов #3');
  eq('meta.annotation', book.meta.annotation, 'Аннотация для теста.');
  ok('обложка извлечена', !!book.coverBlob && book.coverBlob.type === 'image/png', book.coverBlob && book.coverBlob.type);
  eq('оглавление: 5 глав', book.toc.length, 5);
  eq('оглавление: глава 1', book.toc[0].title, 'Глава 1');
  ok('карта секций содержит s3', book.sectionMap.has('s3'));
  ok('карта сносок содержит n1', book.noteMap.has('n1'));

  const host = document.createElement('div');
  host.append(book.content);
  ok('блоков больше 40', host.querySelectorAll(BLOCK_SELECTOR).length > 40, 'блоков: ' + host.querySelectorAll(BLOCK_SELECTOR).length);
  ok('сноска превратилась в ссылку-примечание', !!host.querySelector('[data-note-id="n1"]'));
  ok('таблица отрисована', !!host.querySelector('table.fb2-table'));
  ok('стихи отрисованы', !!host.querySelector('.fb2-v'));
  ok('внутренняя ссылка на секцию помечена', !!host.querySelector('[data-section-id]'));
  const ext = host.querySelector('a[target="_blank"]');
  ok('внешняя ссылка сохранила адрес', ext && String(ext.getAttribute('href')).startsWith('https://example.org'), ext && ext.getAttribute('href'));
  ok('изображение вставлено', !!host.querySelector('img'));
  ok('текст не потерян', host.textContent.includes('гл.5, п.7'));
  ok('эпиграф отрисован', !!host.querySelector('.fb2-epigraph'));
  ok('цитата отрисована', !!host.querySelector('.fb2-cite'));
  ok('подзаголовок отрисован', !!host.querySelector('.fb2-subtitle'));

  // ---------- позиция ----------
  const page = document.getElementById('page');
  const scroll = document.getElementById('scroll');
  const book2 = parseFb2(text);
  page.append(book2.content);
  const blocks = indexBlocks(page, BLOCK_SELECTOR);
  ok('позиция: блоки найдены', blocks.length > 40, 'блоков: ' + blocks.length);

  const layout = await env.prepareLayout(scroll, page, blocks);

  scroll.scrollTop = 750;
  const a1 = anchorAt(scroll, blocks, 6);
  ok('позиция: якорь посчитан', !!a1 && a1.i > 0 && a1.pct > 0 && a1.pct < 1, JSON.stringify(a1));

  scroll.scrollTop = 0;
  applyAnchor(scroll, blocks, a1, 6);
  ok('позиция: восстановление с точностью 3px', Math.abs(scroll.scrollTop - 750) <= 3, 'scrollTop=' + scroll.scrollTop);

  const p1 = percentAt(scroll, blocks, 6);
  ok('позиция: процент совпадает с якорем', Math.abs(p1 - a1.pct) < 0.02, `${p1} vs ${a1.pct}`);

  await layout.setFontScale(1.45);
  applyAnchor(scroll, blocks, a1, 6);
  const a2 = anchorAt(scroll, blocks, 6);
  eq('позиция: тот же блок после смены размера шрифта', a2.i, a1.i);
  ok('позиция: доля внутри блока сохранилась', Math.abs(a2.o - a1.o) < 0.08, `${a1.o} -> ${a2.o}`);

  await layout.setFontScale(1);
  const mid = percentAt(scroll, blocks, 6);
  scroll.scrollTop = 1e9;
  const aEnd = anchorAt(scroll, blocks, 6);
  ok('позиция: в конце книги процент больше', aEnd.pct > mid && aEnd.pct > 0.8, `${mid} -> ${aEnd.pct}`);
  ok('позиция: якорь конца указывает на последний блок', aEnd.i >= blocks.length - 3, `i=${aEnd.i} из ${blocks.length}`);

  // ---------- конфиг ----------
  const cfg = { mode: 'github', owner: 'user', repo: 'fb2-data', branch: 'main', token: 'github_pat_abcdefghijklmnopqrstuvwxyz' };
  const dec = decodeCfg(encodeCfg(cfg));
  ok('конфиг: round-trip', !!dec && dec.owner === 'user' && dec.repo === 'fb2-data' && dec.token === cfg.token && dec.branch === 'main', JSON.stringify(dec));
  ok('конфиг: повреждённая ссылка не ломает приложение', decodeCfg('%%%не-base64%%%') === null);
  ok('конфиг: неполные данные отбрасываются', decodeCfg(encodeCfg({ owner: 'u', repo: '' })) === null);

  return { lines, fails };
}
