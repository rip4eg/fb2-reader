// Публикация читалки на GitHub из командной строки (без git).
//
//   node tools/publish.mjs --token=github_pat_xxx --repo=fb2-reader
//
// Что делает:
//   1. определяет ваш логин по токену;
//   2. создаёт публичный репозиторий приложения (если его нет);
//   3. создаёт приватный репозиторий для книг (если указан --data-repo);
//   4. заливает файлы читалки одним коммитом;
//   5. включает GitHub Pages и ждёт сборки.
//
// Токену нужны права: для создания репозиториев — классический токен со scope repo.
// Если репозитории уже созданы, достаточно fine-grained токена с Contents: Read and write
// на них (и Pages: Read and write, чтобы включить Pages автоматически).

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.github.com';
const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

const args = parseArgs(process.argv);
const token = (args.token || process.env.GITHUB_TOKEN || '').trim();
const repo = args.repo || 'fb2-reader';
const dataRepo = args['data-repo'] === undefined ? 'fb2-data' : args['data-repo'];
const branchArg = args.branch || null;
const source = args.source || join(here, '..');
let owner = args.owner || null;
let branch = branchArg;
const skipPages = !!args['skip-pages'];
const skipData = args['no-data-repo'] === true || dataRepo === 'false';

if (!token) {
  console.error('Не указан токен. Пример:\n  node tools/publish.mjs --token=github_pat_xxx --repo=fb2-reader');
  process.exit(2);
}
if (!/^[\x21-\x7e]+$/.test(token) || token.length < 20) {
  console.error('Токен выглядит некорректно: он должен состоять только из латинских букв, цифр и символов _ - .');
  console.error('Скорее всего при копировании попали лишние символы или токен скопирован не полностью.');
  process.exit(2);
}

const log = (...a) => console.log(...a);

async function api(method, path, body, { allowFail = false } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(API + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok && !allowFail) {
    const msg = (data && data.message) || res.statusText;
    const hint =
      res.status === 401 ? ' — токен не принят GitHub (истёк или скопирован не полностью)' :
      res.status === 403 ? ' — токену не хватает прав' :
      res.status === 404 ? ' — не найдено или нет доступа' : '';
    throw new Error(`${method} ${path} → ${res.status} ${msg}${hint}`);
  }
  return { ok: res.ok, status: res.status, data };
}

async function walk(dir, base = dir, acc = []) {
  for (const name of await readdir(dir)) {
    if (['node_modules', '.git', '__pycache__'].includes(name)) continue;
    const full = join(dir, name);
    const st = await stat(full);
    if (st.isDirectory()) await walk(full, base, acc);
    else if (st.size < 90 * 1024 * 1024) acc.push({ full, rel: relative(base, full).split(sep).join('/') });
  }
  return acc;
}

async function ensureRepo(name, { private: isPrivate, description }) {
  const got = await api('GET', `/repos/${owner}/${name}`, undefined, { allowFail: true });
  if (got.ok) {
    log(`  репозиторий ${owner}/${name} уже есть`);
    return got.data;
  }
  if (got.status !== 404) throw new Error(`Не удалось проверить ${owner}/${name}: ${got.status}`);
  log(`  создаю репозиторий ${owner}/${name} (${isPrivate ? 'приватный' : 'публичный'})…`);
  const created = await api('POST', '/user/repos', {
    name,
    description,
    private: isPrivate,
    auto_init: true,
  });
  await new Promise((r) => setTimeout(r, 2500));
  return created.data;
}

async function pushFiles(name, files, message) {
  let ref = await api('GET', `/repos/${owner}/${name}/git/ref/heads/${branch}`, undefined, { allowFail: true });
  if (!ref.ok) {
    // ветка не появилась (пустой репозиторий) — создаём первый файл через Contents API
    log('  ветка пустая, создаю начальный коммит…');
    await api('PUT', `/repos/${owner}/${name}/contents/README.md`, {
      message: 'Инициализация репозитория',
      content: Buffer.from('# Читалка FB2\n', 'utf8').toString('base64'),
      branch,
    });
    await new Promise((r) => setTimeout(r, 1500));
    ref = await api('GET', `/repos/${owner}/${name}/git/ref/heads/${branch}`);
  }
  const headSha = ref.data.object.sha;
  const head = await api('GET', `/repos/${owner}/${name}/git/commits/${headSha}`);

  const tree = [];
  for (const f of files) {
    const content = await readFile(f.full);
    const blob = await api('POST', `/repos/${owner}/${name}/git/blobs`, {
      content: content.toString('base64'),
      encoding: 'base64',
    });
    tree.push({ path: f.rel, mode: '100644', type: 'blob', sha: blob.data.sha });
    log(`  + ${f.rel} (${(f.full.length, (content.length / 1024).toFixed(1))} КБ)`);
  }

  const newTree = await api('POST', `/repos/${owner}/${name}/git/trees`, { base_tree: head.data.tree.sha, tree });
  const commit = await api('POST', `/repos/${owner}/${name}/git/commits`, {
    message,
    tree: newTree.data.sha,
    parents: [headSha],
  });
  await api('PATCH', `/repos/${owner}/${name}/git/refs/heads/${branch}`, { sha: commit.data.sha, force: false });
  return commit.data.sha;
}

async function enablePages(name) {
  const existing = await api('GET', `/repos/${owner}/${name}/pages`, undefined, { allowFail: true });
  const body = { source: { branch, path: '/' } };
  if (existing.ok) {
    const upd = await api('PUT', `/repos/${owner}/${name}/pages`, body, { allowFail: true });
    if (!upd.ok) log(`  Pages уже включён (обновить настройки не удалось: ${upd.status})`);
  } else {
    const created = await api('POST', `/repos/${owner}/${name}/pages`, body, { allowFail: true });
    if (!created.ok) {
      log(`  не удалось включить Pages автоматически (${created.status}). Включите вручную: Settings → Pages → Deploy from a branch → ${branch} / (root).`);
      return false;
    }
  }
  // ждём сборки
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 6000));
    const st = await api('GET', `/repos/${owner}/${name}/pages`, undefined, { allowFail: true });
    const status = st.ok ? st.data.status : null;
    process.stdout.write(`  сборка Pages: ${status || '…'}\r`);
    if (status === 'built') { log('  сборка Pages: готова        '); return true; }
    if (status === 'errored') { log('  сборка Pages: ошибка        '); return false; }
  }
  log('  сборка Pages занимает больше времени, чем ждали — откройте адрес через пару минут.');
  return true;
}

// ------------------------------------------------------------------ запуск

try {
  const me = await api('GET', '/user');
  if (!owner) owner = me.data.login;
  log(`Аккаунт: ${me.data.login}`);
  log(`Публикация читалки в ${owner}/${repo}${skipData ? '' : `, книги → ${owner}/${dataRepo}`}`);

  await ensureRepo(repo, { private: false, description: 'Читалка FB2 с синхронизацией позиции чтения' })
    .then((r) => { if (!branch) branch = r.default_branch || 'main'; });
  if (!skipData) {
    await ensureRepo(dataRepo, { private: true, description: 'Книги и прогресс чтения для читалки FB2' });
  }
  log(`Ветка: ${branch}`);

  const files = await walk(source);
  log(`Файлов к загрузке: ${files.length}`);
  await pushFiles(repo, files, 'Публикация читалки FB2');

  if (!skipPages) {
    log('Включаю GitHub Pages…');
    await enablePages(repo);
  }

  log('');
  log('═'.repeat(60));
  log(`Читалка:        https://${owner}.github.io/${repo}/`);
  if (!skipData) log(`Репозиторий книг: https://github.com/${owner}/${dataRepo} (приватный)`);
  log('═'.repeat(60));
  log('');
  log('Дальше:');
  log(`  1. Откройте https://${owner}.github.io/${repo}/`);
  log('  2. Создайте fine-grained токен с доступом к репозиторию книг,');
  log('     права Contents: Read and write.');
  log('  3. Введите логин, имя репозитория книг и токен — приложение выдаст');
  log('     ссылку с токеном для остальных устройств.');
} catch (e) {
  console.error('\nОШИБКА: ' + e.message);
  process.exit(1);
}
