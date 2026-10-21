// Прогон всех наборов тестов одной командой: node tests/run-all.mjs (или npm test)
// Кроссплатформенно — в отличие от tests/run-tests.ps1.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUITES = [
  'node-tests.mjs',    // разбор FB2, zip, кодировки, позиция, конфиг
  'scanner-tests.mjs', // сканер папок, архивы, перетаскивание
  'store-tests.mjs',   // хранилище и синхронизация на mock-сервере GitHub
  'smoke-tests.mjs',   // всё приложение целиком в jsdom
];

let failed = 0;
for (const suite of SUITES) {
  console.log(`\n=== ${suite} ===`);
  const res = spawnSync(process.execPath, [join(HERE, suite)], { stdio: 'inherit' });
  if (res.error) {
    console.error(`Не удалось запустить ${suite}: ${res.error.message}`);
    failed++;
  } else if (res.status !== 0) {
    console.error(`${suite}: провал (код ${res.status})`);
    failed++;
  }
}

if (failed) {
  console.log(`\nПровалено наборов: ${failed} из ${SUITES.length}`);
  process.exit(1);
}
console.log(`\nВсе ${SUITES.length} набора тестов пройдены.`);
