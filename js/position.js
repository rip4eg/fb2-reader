// Позиция чтения: якорь «блок + доля внутри блока».
// Блоки идут в потоке документа, поэтому границы монотонны и можно искать двоичным поиском.

import { clamp } from './util.js';

export function indexBlocks(root, selector) {
  return Array.from(root.querySelectorAll(selector));
}

/** Индекс первого блока, нижняя граница которого ниже y. */
export function findBlock(blocks, y) {
  let lo = 0, hi = blocks.length - 1, res = blocks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = blocks[mid].getBoundingClientRect();
    if (r.bottom > y) { res = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return res;
}

/** Текущий якорь: {i, o, pct}. */
export function anchorAt(scroll, blocks, pad = 6) {
  if (!blocks.length) return null;
  const cRect = scroll.getBoundingClientRect();
  const top = cRect.top + pad;
  const i = findBlock(blocks, top);
  const el = blocks[i];
  const r = el.getBoundingClientRect();
  const o = r.height ? clamp((top - r.top) / r.height, 0, 1) : 0;
  const abs = scroll.scrollTop + (r.top - cRect.top);
  const pct = clamp(abs / Math.max(1, scroll.scrollHeight), 0, 1);
  return { i, o, pct };
}

/** Прокручивает к якорю. false — если блок не найден (книга изменилась). */
export function applyAnchor(scroll, blocks, a, pad = 6) {
  if (!blocks.length) return false;
  const el = blocks[a.i];
  if (!el) {
    scroll.scrollTop = (a.pct || 0) * scroll.scrollHeight;
    return false;
  }
  const cRect = scroll.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  scroll.scrollTop = Math.max(0, scroll.scrollTop + (r.top - cRect.top) - pad + (a.o || 0) * r.height);
  return true;
}

/** Доля прочитанного по верхней границе экрана. */
export function percentAt(scroll, blocks, pad = 6) {
  if (!blocks.length) return 0;
  const cRect = scroll.getBoundingClientRect();
  const top = cRect.top + pad;
  let lo = 0, hi = blocks.length - 1, res = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = blocks[mid].getBoundingClientRect();
    if (r.top <= top) { res = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const r = blocks[res].getBoundingClientRect();
  const abs = scroll.scrollTop + (r.top - cRect.top);
  return clamp(abs / Math.max(1, scroll.scrollHeight), 0, 1);
}
