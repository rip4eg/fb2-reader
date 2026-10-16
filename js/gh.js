// Тонкий клиент GitHub REST API: дерево, блобы, атомарные коммиты.

import { utf8ToB64, b64ToBytes, sleep } from './util.js';

export class GhError extends Error {
  constructor(message, status, info) {
    super(message);
    this.name = 'GhError';
    this.status = status;
    this.info = info || null;
  }
}

const encPath = (p) => String(p).split('/').map(encodeURIComponent).join('/');

export class GitHubApi {
  constructor(cfg) {
    this.owner = cfg.owner;
    this.repo = cfg.repo;
    this.branch = cfg.branch || 'main';
    this.token = cfg.token;
    this.api = (cfg.api || 'https://api.github.com').replace(/\/+$/, '');
    this.rate = null;
    this.user = null;
  }

  get repoPath() { return `/repos/${this.owner}/${this.repo}`; }

  async req(method, path, body, opts = {}) {
    // Набор заголовков намеренно минимальный: каждый нестандартный заголовок
    // добавляет браузеру CORS-preflight, а GitHub разрешает не любой набор.
    // Authorization обязателен, Content-Type нужен только при теле запроса —
    // оба разрешены для api.github.com.
    const headers = { Authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.headers) Object.assign(headers, opts.headers);
    let res;
    try {
      res = await fetch(path.startsWith('http') ? path : this.api + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
      });
    } catch (e) {
      throw new GhError('Не удалось связаться с api.github.com. Проверьте интернет, блокировщик рекламы или корпоративный прокси — они могут мешать запросам.', 0, e);
    }
    const rem = res.headers.get('x-ratelimit-remaining');
    if (rem != null) {
      this.rate = {
        remaining: Number(rem),
        limit: Number(res.headers.get('x-ratelimit-limit') || 0),
        reset: Number(res.headers.get('x-ratelimit-reset') || 0),
      };
    }
    if (res.status === 204) return null;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) throw new GhError(this.#message(res.status, data), res.status, data);
    return data;
  }

  #message(status, data) {
    const m = (data && data.message) || '';
    if (status === 401) return 'Токен не принят GitHub (401). Проверьте, что он не истёк и скопирован полностью.';
    if (status === 403) {
      if (this.rate && this.rate.remaining === 0) {
        const t = new Date(this.rate.reset * 1000);
        return `Исчерпан лимит запросов GitHub (5000/час). Сброс в ${t.toLocaleTimeString('ru-RU')}.`;
      }
      return 'GitHub отклонил запрос (403). Скорее всего, токену не выданы права на этот репозиторий. ' + m;
    }
    if (status === 404) return 'Не найдено (404). Проверьте имя владельца и репозитория, а также что токену выдан доступ именно к нему.';
    if (status === 409) return 'Конфликт версий файла (409). Повторяю…';
    if (status === 422) return 'GitHub отклонил данные (422). ' + m;
    return `Ошибка GitHub ${status}: ${m || 'без описания'}`;
  }

  async whoami() {
    if (this.user) return this.user;
    this.user = await this.req('GET', '/user');
    return this.user;
  }

  async getRepo() {
    return await this.req('GET', this.repoPath);
  }

  /** Проверка доступа и определение рабочей ветки. Возвращает {repo, branch}. */
  async connect() {
    const repo = await this.getRepo();
    let branch = this.branch;
    let exists = true;
    try {
      await this.getRef(branch);
    } catch (e) {
      if (e.status === 404 || e.status === 409) {
        exists = false;
        branch = repo.default_branch || 'main';
        this.branch = branch;
      } else throw e;
    }
    if (!exists) {
      try {
        await this.getRef(branch);
      } catch {
        // репозиторий пустой — создаём первый коммит, иначе ветки не существует
        await this.ensureBranch();
      }
    }
    return { repo, branch };
  }

  async getRef(branch = this.branch) {
    return await this.req('GET', `${this.repoPath}/git/ref/heads/${encodeURIComponent(branch)}`);
  }

  async getTree(branch = this.branch) {
    const ref = await this.getRef(branch);
    const tree = await this.req('GET', `${this.repoPath}/git/trees/${ref.object.sha}?recursive=1`);
    return { head: ref.object.sha, tree: tree.tree || [], truncated: !!tree.truncated };
  }

  async getBlobBase64(sha) {
    const b = await this.req('GET', `${this.repoPath}/git/blobs/${sha}`);
    return b.content || '';
  }

  async getBlobBytes(sha) {
    return b64ToBytes(await this.getBlobBase64(sha));
  }

  async getFileMeta(path, branch = this.branch) {
    try {
      return await this.req('GET', `${this.repoPath}/contents/${encPath(path)}?ref=${encodeURIComponent(branch)}`);
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  async getFileText(path, branch = this.branch) {
    const f = await this.getFileMeta(path, branch);
    if (!f) return null;
    if (f.encoding === 'base64' && f.content) return new TextDecoder().decode(b64ToBytes(f.content));
    if (f.sha) return new TextDecoder().decode(await this.getBlobBytes(f.sha));
    return null;
  }

  /** Запись небольшого текстового файла через Contents API (2 запроса). */
  async putFileText(path, text, message) {
    const cur = await this.getFileMeta(path);
    const body = {
      message,
      content: utf8ToB64(text),
      branch: this.branch,
      committer: this.committer,
    };
    if (cur && cur.sha) body.sha = cur.sha;
    try {
      return await this.req('PUT', `${this.repoPath}/contents/${encPath(path)}`, body);
    } catch (e) {
      if (e.status === 409 || e.status === 422) {
        const again = await this.getFileMeta(path);
        if (again && again.sha) body.sha = again.sha;
        return await this.req('PUT', `${this.repoPath}/contents/${encPath(path)}`, body);
      }
      throw e;
    }
  }

  /**
   * Атомарный коммит нескольких файлов через Git Data API.
   * files: [{path, base64}] или [{path, remove:true}]
   */
  async commitFiles(files, message) {
    const entries = [];
    for (const f of files) {
      if (f.remove) { entries.push({ path: f.path, mode: '100644', type: 'blob', sha: null }); continue; }
      const blob = await this.req('POST', `${this.repoPath}/git/blobs`, { content: f.base64, encoding: 'base64' });
      entries.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    if (!entries.length) return null;

    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const ref = await this.getRef();
        const headSha = ref.object.sha;
        const headCommit = await this.req('GET', `${this.repoPath}/git/commits/${headSha}`);
        const tree = await this.req('POST', `${this.repoPath}/git/trees`, {
          base_tree: headCommit.tree.sha,
          tree: entries,
        });
        const commit = await this.req('POST', `${this.repoPath}/git/commits`, {
          message,
          tree: tree.sha,
          parents: [headSha],
        });
        await this.req('PATCH', `${this.repoPath}/git/refs/heads/${encodeURIComponent(this.branch)}`, {
          sha: commit.sha,
          force: false,
        });
        return commit.sha;
      } catch (e) {
        lastErr = e;
        if (e.status === 409 || e.status === 422 || e.status === 404) {
          await sleep(300 + attempt * 500);
          continue;
        }
        throw e;
      }
    }
    throw lastErr || new GhError('Не удалось создать коммит', 0);
  }

  /** Если репозиторий пустой — создаём первый коммит, чтобы появилась ветка. */
  async ensureBranch() {
    try {
      await this.getRef(this.branch);
      return false;
    } catch (e) {
      if (e.status !== 404 && e.status !== 409) throw e;
    }
    const repo = await this.getRepo();
    const branch = repo.default_branch || this.branch;
    await this.req('PUT', `${this.repoPath}/contents/README.md`, {
      message: 'Инициализация хранилища читалки',
      content: utf8ToB64('# Хранилище читалки FB2\n\nЗдесь лежат книги и прогресс чтения. Редактируется приложением.\n'),
      branch,
    });
    this.branch = branch;
    return true;
  }
}
