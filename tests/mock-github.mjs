// Мок GitHub REST API: достаточный, чтобы прогнать клиент хранилища без сети.

function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return 'sha' + h.toString(16) + str.length.toString(16);
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64').toString('utf8');

export class MockGitHub {
  constructor(opts = {}) {
    this.owner = opts.owner || 'user';
    this.repo = opts.repo || 'fb2-data';
    this.branch = opts.branch || 'main';
    this.files = new Map();     // path -> base64
    this.blobs = new Map();     // sha -> base64
    this.trees = new Map();
    this.commits = new Map();
    this.head = null;
    this.calls = { total: 0, patch: 0, put: 0 };
    this.failNextPatch = 0;
    this.requestLog = [];
  }

  putBlob(base64) {
    const sha = djb2(base64);
    this.blobs.set(sha, base64);
    return sha;
  }

  headers() {
    return new Map([
      ['x-ratelimit-remaining', '4999'],
      ['x-ratelimit-limit', '5000'],
      ['x-ratelimit-reset', String(Math.floor(Date.now() / 1000) + 3600)],
    ]);
  }

  json(data, status = 200) {
    const text = JSON.stringify(data);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : String(status),
      headers: this.headers(),
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  }

  err(status, message) {
    return this.json({ message }, status);
  }

  async fetch(url, init = {}) {
    this.calls.total++;
    const method = (init.method || 'GET').toUpperCase();
    const u = new URL(url);
    const p = u.pathname;
    this.requestLog.push(method + ' ' + p);
    const body = init.body ? JSON.parse(init.body) : null;
    const base = `/repos/${this.owner}/${this.repo}`;

    if (p === '/user') return this.json({ login: 'tester' });
    if (p === base) {
      if (this.denied) return this.err(404, 'Not Found');
      return this.json({ name: this.repo, private: true, default_branch: this.branch, permissions: { push: true } });
    }

    if (p.startsWith(base + '/git/ref/heads/')) {
      const br = decodeURIComponent(p.slice((base + '/git/ref/heads/').length));
      if (br !== this.branch || !this.head) return this.err(404, 'Not Found');
      return this.json({ ref: `refs/heads/${br}`, object: { sha: this.head } });
    }

    if (p.startsWith(base + '/git/commits/')) {
      const sha = p.slice((base + '/git/commits/').length);
      const c = this.commits.get(sha);
      if (!c) return this.err(404, 'Not Found');
      return this.json({ sha, tree: { sha: c.tree }, parents: c.parents.map((s) => ({ sha: s })) });
    }

    if (p.startsWith(base + '/git/trees/')) {
      const sha = p.slice((base + '/git/trees/').length);
      if (sha !== 'HEAD' && !this.trees.has(sha) && !this.commits.has(sha)) return this.err(404, 'Not Found');
      const entries = Array.from(this.files.entries()).map(([path, content]) => ({
        path, mode: '100644', type: 'blob', sha: this.blobShaOf(content), size: unb64(content).length,
      }));
      return this.json({ sha, tree: entries, truncated: false });
    }

    if (p.startsWith(base + '/git/blobs/')) {
      const sha = p.slice((base + '/git/blobs/').length);
      const content = this.blobs.get(sha);
      if (content == null) return this.err(404, 'Not Found');
      return this.json({ sha, content, encoding: 'base64', size: unb64(content).length });
    }

    if (p === base + '/git/blobs' && method === 'POST') {
      if (!body || typeof body.content !== 'string') return this.err(422, 'invalid');
      return this.json({ sha: this.putBlob(body.content) });
    }

    if (p === base + '/git/trees' && method === 'POST') {
      if (!body || !body.base_tree || !this.trees.has(body.base_tree)) return this.err(422, 'bad base tree');
      const sha = djb2(JSON.stringify(body.entries || body.tree) + Math.random());
      this.trees.set(sha, { base: body.base_tree, entries: body.tree });
      return this.json({ sha });
    }

    if (p === base + '/git/commits' && method === 'POST') {
      const tree = this.trees.get(body.tree);
      if (!tree) return this.err(422, 'bad tree');
      const sha = djb2(JSON.stringify({ tree: body.tree, parents: body.parents, m: body.message }));
      this.commits.set(sha, { tree: body.tree, parents: body.parents || [], pending: true });
      return this.json({ sha });
    }

    if (p.startsWith(base + '/git/refs/heads/') && method === 'PATCH') {
      this.calls.patch++;
      if (this.failNextPatch > 0) { this.failNextPatch--; return this.err(422, 'Update is not a fast forward'); }
      const c = this.commits.get(body.sha);
      if (!c) return this.err(422, 'unknown commit');
      if (this.head && c.parents[0] !== this.head) return this.err(422, 'Update is not a fast forward');
      // применяем дерево
      const tree = this.trees.get(c.tree);
      for (const e of tree.entries) {
        if (e.sha === null) this.files.delete(e.path);
        else this.files.set(e.path, this.blobs.get(e.sha));
      }
      this.head = body.sha;
      delete c.pending;
      return this.json({ object: { sha: body.sha } });
    }

    const contentsPrefix = base + '/contents/';
    if (p.startsWith(contentsPrefix)) {
      const path = decodeURIComponent(p.slice(contentsPrefix.length));
      if (method === 'GET') {
        if (!this.files.has(path)) return this.err(404, 'Not Found');
        const content = this.files.get(path);
        return this.json({ name: path.split('/').pop(), path, sha: this.blobShaOf(content), size: unb64(content).length, content, encoding: 'base64', type: 'file' });
      }
      if (method === 'PUT') {
        this.calls.put++;
        const cur = this.files.get(path);
        if (body.sha && cur && body.sha !== this.blobShaOf(cur)) return this.err(409, 'sha does not match');
        if (body.sha && !cur) return this.err(404, 'Not Found');
        // в пустом репозитории создаём ветку
        if (!this.head) {
          const treeSha = djb2('init-tree');
          this.trees.set(treeSha, { base: null, entries: [] });
          const commitSha = djb2('init-commit');
          this.commits.set(commitSha, { tree: treeSha, parents: [] });
          this.head = commitSha;
        }
        const blobSha = this.putBlob(body.content);
        this.files.set(path, body.content);
        return this.json({ content: { sha: blobSha, path }, commit: { sha: this.head } });
      }
    }

    return this.err(404, 'Not Found');
  }

  blobShaOf(content) {
    const sha = djb2(content);
    if (!this.blobs.has(sha)) this.blobs.set(sha, content);
    return sha;
  }
}
