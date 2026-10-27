import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sandboxRuntime } from './runtime.mjs';

const actors = { sender: 'bob', receiver: 'alice' };
const exists = async p => { try { await readFile(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const atomicJson = async (p, value) => { await writeFile(p + '.next', JSON.stringify(value, null, 2)); await rename(p + '.next', p); };
const jsonRead = async p => JSON.parse(await readFile(p, 'utf8'));

export async function prepareSandboxRoot(root, hostRoot) {
  root = resolve(root); hostRoot = resolve(hostRoot);
  assert.ok(root !== hostRoot && !root.startsWith(hostRoot + '/'), 'Sandbox data cannot live in the Host checkout');
  await mkdir(root, { recursive: true });
  const marker = join(root, 'sandbox.json');
  if (await exists(marker)) assert.equal((await jsonRead(marker)).schema, 'issue-interactive-sandbox.v1');
  else {
    assert.deepEqual(await readdir(root), [], 'Use a new empty directory; existing non-sandbox data is never adopted');
    await atomicJson(marker, { schema: 'issue-interactive-sandbox.v1' });
  }
}

export async function startSandbox({ root, hostRoot, archive, port = 0, automatic = true, allowArchiveUpgrade = false }) {
  assert.ok(root && hostRoot && archive, 'Explicit isolated data root, compiled Host and archive are required');
  root = resolve(root); hostRoot = resolve(hostRoot); archive = resolve(archive);
  await prepareSandboxRoot(root, hostRoot);
  const lock = join(root, 'sandbox.lock');
  try { const f = await open(lock, 'wx'); await f.writeFile(String(process.pid)); await f.close(); }
  catch (e) { throw new Error('Sandbox data is already in use; stop its existing process: ' + lock, { cause: e }); }
  let runtime, timer, server, closing = false, chain = Promise.resolve();
  const previews = {}, hosts = {}, actorErrors = {};
  const savedEnvironment = { PATH: process.env.PATH, ISSUE_HOST_TEST_GITHUB: process.env.ISSUE_HOST_TEST_GITHUB,
    ISSUE_HOST_TEST_ACTOR: process.env.ISSUE_HOST_TEST_ACTOR, DEFAULT_OWNER_USER_ID: process.env.DEFAULT_OWNER_USER_ID };
  const queue = fn => { const r = chain.then(fn); chain = r.catch(() => {}); return r; };
  const asActor = async (actor, fn) => {
    assert.ok(Object.hasOwn(actors, actor), 'Unknown sandbox account'); process.env.ISSUE_HOST_TEST_ACTOR = actors[actor];
    try { return await fn(); } finally { delete process.env.ISSUE_HOST_TEST_ACTOR; }
  };
  const settingsFile = join(root, 'settings.json'), githubFile = join(root, 'github.json');
  const settings = await exists(settingsFile) ? await jsonRead(settingsFile) : { catMode: 'success' };
  const persist = () => atomicJson(settingsFile, settings);
  const github = () => jsonRead(githubFile);
  const editGithub = async fn => { const s = await github(); fn(s); await atomicJson(githubFile, s); };
  const close = async () => {
    if (closing) return; closing = true; clearTimeout(timer);
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await chain;
    for (const p of Object.values(previews)) { p.closeAllConnections(); await new Promise(resolve => p.close(resolve)); }
    try { await runtime?.close(); } finally {
      for (const [k, v] of Object.entries(savedEnvironment)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      await unlink(lock);
    }
  };
  try {
    const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
    const marker = await jsonRead(join(root, 'sandbox.json'));
    assert.ok(!marker.archiveDigest || marker.archiveDigest === digest || allowArchiveUpgrade,
      'Retained data belongs to a different archive; reuse its pinned package or explicitly upgrade this isolated sandbox');
    await persist();
    if (!await exists(githubFile)) await atomicJson(githubFile, { login: 'bob', calls: [], comments: [], timeline: [], issues: [
      { node_id: 'I_sandbox_1', number: 1, title: '启动后工作台一直加载', body: '打开工作台后一直显示加载中，无法继续处理问题。刷新也没有恢复。', author: 'alice' },
      { node_id: 'I_sandbox_2', number: 2, title: '希望批量分类时能暂停', body: '处理一批问题时需要暂停，检查分类结果后再继续。', author: 'bob' },
      { node_id: 'I_sandbox_3', number: 3, title: '窄屏下说明文字被截断', body: '手机浏览工作台时，说明文字超出边界。可以横屏临时查看。', author: 'alice' },
    ].map(({ author, ...i }) => ({ ...i, state: 'open', updated_at: '2026-10-21T00:00:00Z', user: { login: author },
      body: i.body + '\n## Environment\nmacOS', labels: [], assignees: [], html_url: 'https://github.com/fixture/repo/issues/' + i.number })) });
    const bin = join(root, 'bin'); await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'gh'), '#!' + process.execPath + '\n' + await readFile(new URL('../../test/helpers/host-github-fixture.mjs', import.meta.url), 'utf8'));
    await chmod(join(bin, 'gh'), 0o700); process.env.PATH = bin + ':' + process.env.PATH; process.env.ISSUE_HOST_TEST_GITHUB = githubFile;
    runtime = await sandboxRuntime({ root, hostRoot, archive, settings, allowArchiveUpgrade });
    for (const actor of Object.keys(actors)) hosts[actor] = await asActor(actor, () => runtime.createHost(actor));
    // Advance the pin only after both real Host instances admit the replacement.
    await atomicJson(join(root, 'sandbox.json'), { ...marker, archiveDigest: digest, archive });
    // Admission validates the original archive before its UI assets are extracted.
    const unpacked = join(root, 'archives', digest); await mkdir(unpacked, { recursive: true });
    if (!await exists(join(unpacked, 'package/package.json'))) execFileSync('tar', ['-xzf', archive, '-C', unpacked]);
    const dist = join(unpacked, 'package/dist');
    const { coordinationPreview, fixtureBindings } = await import(pathToFileURL(join(dist, 'coordination-host.mjs')).href);
    function fact(i) { return { id: i.node_id, number: i.number, title: i.title, body: i.body, state: i.state.toUpperCase(),
      updatedAt: i.updated_at, url: i.html_url, labels: i.labels.map(l => l.name), author: i.user.login }; }
    const binding = actor => ({
      profile: { id: 'sandbox-github', name: '模拟 GitHub · fixture/repo', provider: 'github', instance: 'https://github.com',
        repositoryId: 'sandbox-repo', repository: 'fixture/repo', visibility: 'public' },
      authorize: async () => (await hosts[actor].detail()).intent !== 'disabled',
      catalog: async () => {
        const s = await github(); if (s.offline) throw new Error('模拟 GitHub 离线，恢复网络后重试');
        return { repo: 'fixture/repo', revision: 1, fetchedAt: new Date().toISOString(), lastCompleteAt: new Date().toISOString(),
          issues: s.issues.map(fact), failures: [], summary: { added: 0, changed: 0, closed: 0, reopened: 0 } };
      },
      detail: async ref => {
        const s = await github(); if (s.offline) throw new Error('模拟 GitHub 离线，恢复网络后重试');
        const i = s.issues.find(i => i.node_id === ref.issueId);
        return { fact: i ? { ...fact(i), comments: s.comments.filter(c => c.issue_url.endsWith('/' + i.number))
          .map(c => ({ id: String(c.id), author: c.user.login, body: c.body, createdAt: c.created_at, url: i.html_url + '#issuecomment-' + c.id })) } : null };
      },
    });
    for (const actor of Object.keys(actors)) {
      const p = coordinationPreview({ dataRoot: join(root, actor, 'workbench'), dist, bindings: [binding(actor), fixtureBindings()[1]],
        teamAction: async (name, input, confirmed) => {
          const r = await hosts[actor].request(name, input, { confirmed });
          if (r.statusCode !== 200) throw Object.assign(new Error(r.json().error ?? r.body), { status: r.statusCode }); return r.json();
        } });
      await new Promise(resolve => p.listen(0, '127.0.0.1', resolve)); previews[actor] = p;
    }
    async function tick() {
      for (const actor of Object.keys(actors)) await asActor(actor, async () => {
        try {
          const h = hosts[actor]; if ((await h.detail()).intent === 'disabled') return;
          for (const task of h.schedules.values()) await task.run.execute({});
          const rows = (await h.action('summary', { kind: 'analysis' })).rows;
          if (settings.catMode === 'success') for (const row of rows) if (row.kind === 'analysis' && !row.analysis && row.status === 'delivered') {
            const i = (await github()).issues.find(i => i.number === row.issue.number);
            await h.native('submit', { id: row.id, analysis: { category: i.number === 1 ? 'runtime' : i.number === 2 ? 'feature' : 'ui',
              score: i.number === 1 ? 9 : i.number === 2 ? 5 : 3,
              reason: '模拟研判结果：用于体验分类、反馈和任务流转，不代表真实模型判断。', evidence: i.body,
              blocksRuntime: i.number === 1, workaround: i.number === 3 ? '横屏查看' : '' } });
          }
          delete actorErrors[actor];
        } catch (e) { actorErrors[actor] = e.message; }
      });
    }
    async function state() {
      const participants = {};
      for (const actor of Object.keys(actors)) await asActor(actor, async () => {
        const detail = await hosts[actor].detail(); let rows = [], error = actorErrors[actor];
        if (detail.intent !== 'disabled') try { rows = (await hosts[actor].action('summary')).rows; } catch (e) { error = e.message; }
        participants[actor] = { login: actors[actor], enabled: detail.intent !== 'disabled', live: detail.live, rows, error };
      });
      const g = await github(); return { mode: 'isolated-simulation', root, catMode: settings.catMode, offline: !!g.offline, participants,
        issues: g.issues.map(fact), comments: g.comments, realGitHubWrites: 0, realModelInvocations: 0 };
    }
    async function control(input) {
      switch (input.action) {
        case 'mode': assert.ok(['success', 'failure', 'timeout'].includes(input.value)); settings.catMode = input.value; await persist(); break;
        case 'network': assert.equal(typeof input.offline, 'boolean'); await editGithub(g => { g.offline = input.offline; }); break;
        case 'enabled': assert.equal(typeof input.enabled, 'boolean'); await asActor(input.actor, () => hosts[input.actor].enable(input.enabled)); break;
        case 'report':
          assert.equal(input.actor, 'receiver', 'Only the simulated recipient reports on its own invitation');
          await asActor(input.actor, () => hosts[input.actor].native('report', { id: input.id, status: input.status,
            summary: input.summary, evidenceUrls: input.evidenceUrls ?? [] })); break;
        case 'source':
          assert.ok(['open', 'closed'].includes(input.state));
          await editGithub(g => { const i = g.issues.find(i => i.number === input.number); assert.ok(i); i.state = input.state; i.updated_at = new Date().toISOString(); }); break;
        case 'tick': await tick(); break;
        default: throw new Error('Unknown sandbox action');
      }
      return state();
    }
    const uiFiles = { '/': ['index.html', 'text/html'], '/sandbox/ui.js': ['ui.js', 'text/javascript'],
      '/sandbox/ui.css': ['ui.css', 'text/css'], '/sandbox/workbench.js': ['workbench.js', 'text/javascript'] };
    server = createServer(async (req, res) => {
      const actualPort = server.address().port;
      const validHosts = ['127.0.0.1:' + actualPort, 'localhost:' + actualPort, 'preview-' + actualPort + '.localhost:4100'];
      if (!validHosts.includes(req.headers.host) || (req.headers.origin && !validHosts.map(h => 'http://' + h).includes(req.headers.origin))) { res.writeHead(403).end('Origin not allowed'); return; }
      res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'" + (req.headers.host.startsWith('preview-') ? " 'unsafe-inline'" : '') + "; style-src 'self'; frame-ancestors 'self' http://localhost:4100 http://127.0.0.1:4100");
      const url = new URL(req.url, 'http://' + req.headers.host);
      try {
        if (req.method === 'GET' && uiFiles[url.pathname]) { const [file, type] = uiFiles[url.pathname]; res.setHeader('content-type', type + '; charset=utf-8'); res.end(await readFile(new URL(file, import.meta.url))); return; }
        if (req.method === 'GET' && /^\/(sender|receiver)\/$/.test(url.pathname)) { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(await readFile(new URL('workbench.html', import.meta.url))); return; }
        if (req.method === 'GET' && ['/assets/browser.js', '/assets/browser.css'].includes(url.pathname)) { res.setHeader('content-type', url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css'); res.end(await readFile(join(dist, url.pathname.split('/').at(-1)))); return; }
        if (url.pathname === '/health' && req.method === 'GET') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, mode: 'isolated-simulation' })); return; }
        if (url.pathname === '/sandbox/state' && req.method === 'GET') { const v = await queue(state); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(v)); return; }
        if (url.pathname === '/sandbox/control' && req.method === 'POST') {
          if (req.headers['x-issue-sandbox'] !== 'simulation' || !req.headers['content-type']?.startsWith('application/json')) { res.writeHead(403).end(); return; }
          let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 16000) throw new Error('Request too large'); }
          const v = await queue(() => control(JSON.parse(body))); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(v)); return;
        }
        const routed = /^\/(sender|receiver)(\/api\/.*)$/.exec(url.pathname);
        if (routed) {
          const [, actor, path] = routed;
          await queue(() => asActor(actor, () => new Promise((done, reject) => {
            const targetPort = previews[actor].address().port;
            const proxy = httpRequest({ hostname: '127.0.0.1', port: targetPort, path: path + url.search, method: req.method,
              headers: { ...req.headers, host: '127.0.0.1:' + targetPort, origin: 'http://127.0.0.1:' + targetPort } }, upstream => {
              res.statusCode = upstream.statusCode; res.setHeader('content-type', upstream.headers['content-type'] ?? 'application/json');
              upstream.pipe(res); upstream.once('end', done); upstream.once('error', reject);
            });
            proxy.setTimeout(45000, () => proxy.destroy(new Error('Sandbox request timed out')));
            proxy.once('error', reject);
            req.once('aborted', () => proxy.destroy(new Error('Browser request cancelled')));
            res.once('close', () => { if (!res.writableEnded) proxy.destroy(new Error('Browser disconnected')); });
            req.pipe(proxy);
          }))); return;
        }
        res.writeHead(404).end();
      } catch (e) { if (!res.headersSent) res.writeHead(e.status ?? 400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    const cycle = async () => { if (closing) return; await queue(tick); if (!closing) timer = setTimeout(cycle, 2500); };
    if (automatic) timer = setTimeout(cycle, 1500);
    return { url: 'http://127.0.0.1:' + server.address().port, close, root };
  } catch (e) { await close(); throw e; }
}
