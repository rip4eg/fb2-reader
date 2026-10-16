// Запуск того же набора тестов в Node через jsdom (когда браузер недоступен).
//   node tests/node-tests.mjs
// jsdom подхватывается из JSDOM_PATH или из обычного разрешения модулей.

import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

const jsdomTarget = process.env.JSDOM_PATH
  ? (isAbsolute(process.env.JSDOM_PATH) ? pathToFileURL(process.env.JSDOM_PATH).href : process.env.JSDOM_PATH)
  : 'jsdom';
const { JSDOM } = await import(jsdomTarget);
const dom = new JSDOM('<!doctype html><html><body><div id="scroll"><div id="page" class="fb2-body"></div></div></body></html>', {
  pretendToBeVisual: true,
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.Node = dom.window.Node;
globalThis.Element = dom.window.Element;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.Event = dom.window.Event;
globalThis.NodeFilter = dom.window.NodeFilter;

globalThis.URL.createObjectURL = () => 'blob:stub';
globalThis.URL.revokeObjectURL = () => {};

const { runSuite } = await import('./suite.js');

// --- имитация раскладки: jsdom не считает геометрию, задаём её вручную ---
function prepareLayoutSim(scroll, page, blocks) {
  const state = { scrollTop: 0, blockH: 30, pad: 8 };
  Object.defineProperty(scroll, 'scrollTop', {
    configurable: true,
    get: () => state.scrollTop,
    set: (v) => { state.scrollTop = Math.max(0, Number(v) || 0); },
  });
  Object.defineProperty(scroll, 'scrollHeight', {
    configurable: true,
    get: () => state.pad * 2 + blocks.length * state.blockH,
  });
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, get: () => 300 });
  scroll.getBoundingClientRect = () => ({ top: 0, left: 0, right: 640, bottom: 300, width: 640, height: 300, x: 0, y: 0 });
  blocks.forEach((el, i) => {
    el.getBoundingClientRect = () => {
      const top = state.pad + i * state.blockH - state.scrollTop;
      return { top, bottom: top + state.blockH, height: state.blockH, left: 0, right: 640, width: 640, x: 0, y: top };
    };
  });
  return {
    async setFontScale(k) { state.blockH = Math.round(30 * k); },
  };
}

const res = await runSuite({
  readBytes: async (p) => {
    const b = await readFile(join(HERE, p));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  },
  readText: async (p) => await readFile(join(HERE, p), 'utf8'),
  prepareLayout: async (scroll, page, blocks) => prepareLayoutSim(scroll, page, blocks),
});

let failed = 0;
for (const l of res.lines) {
  if (!l.pass) failed++;
  console.log(`${l.pass ? 'PASS' : 'FAIL'} | ${l.name}${l.extra ? ' | ' + l.extra : ''}`);
}
console.log(failed === 0 ? `\nВСЕ ТЕСТЫ ПРОЙДЕНЫ (${res.lines.length})` : `\nПРОВАЛЕНО: ${failed} из ${res.lines.length}`);
process.exit(failed === 0 ? 0 : 1);
