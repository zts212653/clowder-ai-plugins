import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { IssueCoordinationService, IssueCoordinationStore, FileIssueSourceStore, IssueSourceService,
  createGhIssueSourceReader, decodeGhSourceResponse } from '../dist/index.js';

// Public, evidence-backed seed shipped with this plugin; never injected into another source.
const initialSeed = JSON.parse(readFileSync(new URL('../data/first-classification.v1.json', import.meta.url), 'utf8'));
export const initialClassifications = initialSeed.suggestions.map(suggestion => ({
  id: initialSeed.schema + ':' + suggestion.source.issueId,
  model: initialSeed.method.model, generatedAt: initialSeed.createdAt, source: suggestion.source,
  labels: Object.fromEntries(Object.entries(suggestion.labels).map(([facet, ids]) => [facet, ids.map(id => initialSeed.taxonomy[facet][id])])),
  evidence: suggestion.evidence.excerpt,
}));

const syntheticIssue = (id, number, title, state = 'OPEN') => ({ id, number, title, state,
  url: 'https://example.invalid/issues/' + number, labels: [], updatedAt: '2026-10-14T10:00:00Z',
  body: '合成测试内容：用于验证内外关联及分仓修复。此问题没有连接真实内源平台。', comments: [] });
export function fixtureBindings() {
  const publicIssues = [syntheticIssue('public-88', 88, '上游修复：重复加载问题', 'CLOSED')];
  const internalIssues = [syntheticIssue('internal-24', 24, '内部适配版本仍可复现重复加载'), syntheticIssue('internal-88', 88, '内部同号问题：验证来源隔离')];
  return [['public', '公开测试仓', publicIssues], ['internal', '内源合成测试仓', internalIssues]].map(([id, name, issues]) => ({
    profile: { id, name, provider: 'synthetic', instance: 'https://' + id + '.example.invalid', repositoryId: id + '-repo', repository: id + '/test', visibility: id === 'public' ? 'public' : 'internal', synthetic: true },
    authorize: async () => true,
    catalog: async () => ({ repo: id + '/test', revision: 1, fetchedAt: issues[0].updatedAt, lastCompleteAt: issues[0].updatedAt, issues, failures: [], summary: { added: 0, changed: 0, closed: 0, reopened: 0 } }),
    detail: async ref => ({ fact: issues.find(i => i.id === ref.issueId) ?? null }),
  }));
}
/** Explicit public READ Host. CLI credentials stay here; no dependency on a second preview server. */
export function githubPreviewBinding({ dataRoot, query } = {}) {
  if (!dataRoot) throw new Error('GitHub READ preview requires an isolated dataRoot');
  const execute = promisify(execFile);
  const read = query ?? (async (document, variables) => {
    const args = ['api', 'graphql', '--hostname', 'github.com', '-f', `query=${document}`];
    for (const [key, value] of Object.entries(variables)) args.push('-f', `${key}=${value}`);
    let stdout;
    try {
      ({ stdout } = await execute('gh', args, { timeout: 45000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }));
    } catch (error) {
      if (!error.stdout?.trim()) throw error;
      stdout = error.stdout;
    }
    return decodeGhSourceResponse(stdout);
  });
  const repo = 'zts212653/clowder-ai';
  const service = new IssueSourceService(new FileIssueSourceStore(join(dataRoot, 'github-read')), createGhIssueSourceReader(read));
  return {
    profile: { id: 'github.com:R_kgDORlB5aQ', provider: 'github', instance: 'https://github.com', repositoryId: 'R_kgDORlB5aQ', repository: 'zts212653/clowder-ai', name: 'GitHub · clowder-ai', visibility: 'public' },
    // Public data ONLY. A production Host must replace this with its current grant resolver.
    authorize: async () => true,
    classifications: initialClassifications,
    catalog: async refresh => refresh ? service.refresh(repo) : (await service.read(repo)) ?? service.refresh(repo),
    detail: async (ref, offset = 0, version) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || (offset > 0 && !version)) throw new Error('Invalid detail page');
      const result = offset ? { detail: await service.readDetail(repo, ref.number, version) } : await service.refreshDetail(repo, ref.number);
      const fact = result.detail, comments = fact?.comments ?? [], end = Math.min(offset + 25, comments.length);
      return { fact: fact ? { ...fact, comments: comments.slice(offset, end) } : null,
        nextOffset: end < comments.length ? end : null, error: result.failures?.map(f => f.message).join('；') || undefined };
    },
  };
}
export function coordinationPreview({ dataRoot, dist, bindings = fixtureBindings(), allowedOrigins = [], allowedHosts = [], teamAction }) {
  if (!dataRoot || !dist) throw new Error('Explicit isolated dataRoot and dist are required');
  const service = new IssueCoordinationService(new IssueCoordinationStore(dataRoot), bindings, 'preview-owner');
  const assets = { '/': ['coordination.html', 'text/html'], '/installed.html': ['installed.html', 'text/html'], '/installed.js': ['installed.js', 'text/javascript'], '/coordination.js': ['coordination.js','text/javascript'], '/browser.js': ['browser.js','text/javascript'], '/browser.css': ['browser.css','text/css'] };
  const server = createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff');
    const port = server.address()?.port, host = req.headers.host, origin = req.headers.origin;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, ...allowedHosts];
    const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...allowedOrigins];
    if (!hosts.includes(host) || (origin && !origins.includes(origin))) { res.writeHead(403); res.end('Origin not allowed'); return; }
    // The approved local Preview Gateway injects its inline attestation bridge.
    // This exception is confined to that acceptance hostname, never the production Host.
    const scriptPolicy = host === `preview-${port}.localhost:4100` ? "'self' 'unsafe-inline'" : "'self'";
    res.setHeader('content-security-policy', `default-src 'self'; script-src ${scriptPolicy}; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'self' http://localhost:4100 http://127.0.0.1:4100`);
    const url = new URL(req.url, 'http://' + host), asset = assets[url.pathname];
    try {
      if (asset && req.method === 'GET') { res.setHeader('content-type', asset[1] + '; charset=utf-8'); res.end(await readFile(join(dist, asset[0]))); return; }
      if (url.pathname === '/health' && req.method === 'GET') { res.setHeader('content-type','application/json'); res.end(JSON.stringify({ ok: true, mode: 'isolated-acceptance', revision: 'issue-coordination-v1' })); return; }
      // Explicit acceptance injection only. The ordinary READ preview has no
      // owner authority, no native caller and no automatic connection to a Host.
      const team = /^\/api\/plugins\/dev\.clowder\.issue-workbench\/actions\/teamWorkbench\/(summary|get|analyze|assign|assignIssue|retry|republish|feedback|planClassification|controlClassification|coordination|acceptInbox)$/.exec(url.pathname);
      if (team) {
        if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) { res.writeHead(403); res.end(); return; }
        if (!teamAction) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Team Host is not connected' })); return; }
        let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > (team[1] === 'coordination' ? 256000 : 32000)) throw new Error('Request too large'); }
        const body = JSON.parse(raw);
        if (!body || typeof body.payload !== 'string' || Object.keys(body).some(key => key !== 'payload')) throw new Error('Invalid team input');
        const result = await teamAction(team[1], JSON.parse(body.payload), req.headers['x-cat-cafe-owner-confirmed'] === 'true');
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result)); return;
      }
      let result;
      if (url.pathname === '/api/issue-coordination/state' && req.method === 'GET') result = await service.load();
      else {
        if (req.method !== 'POST' || req.headers['x-issue-coordination'] !== 'local-work' || !req.headers['content-type']?.startsWith('application/json')) { res.writeHead(403); res.end('Request not allowed'); return; }
        let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 256000) throw new Error('Request too large'); }
        const payload = JSON.parse(body);
        switch (url.pathname) {
          case '/api/issue-coordination/refresh': result = await service.load(true); break;
          case '/api/issue-coordination/detail': result = await service.detail(payload.ref, payload.offset, payload.version); break;
          case '/api/issue-coordination/work': result = await service.saveWork(payload.value, payload.expectedRevision); break;
          case '/api/issue-coordination/relation': result = await service.saveRelation(payload.value, payload.expectedRevision); break;
          case '/api/issue-coordination/preference': result = await service.savePreference(payload.sourceId, payload.value, payload.expectedRevision); break;
          default: res.writeHead(404); res.end(); return;
        }
      }
      res.setHeader('content-type','application/json'); res.end(JSON.stringify(result));
    } catch (error) { res.writeHead(error.status ?? 400, { 'content-type':'application/json' }); res.end(JSON.stringify({ error: error.message })); }
  });
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.env.ISSUE_COORDINATION_DATA_DIR;
  if (!root) throw new Error('Set ISSUE_COORDINATION_DATA_DIR to a dedicated acceptance data directory');
  const port = Number(process.env.PORT ?? 5196);
  const bindings = process.env.ISSUE_COORDINATION_GITHUB === '1' ? [githubPreviewBinding({ dataRoot: root }), fixtureBindings()[1]] : fixtureBindings();
  coordinationPreview({ dataRoot: root, dist: fileURLToPath(new URL('../dist', import.meta.url)), bindings,
    allowedHosts: [`preview-${port}.localhost:4100`], allowedOrigins: [`http://preview-${port}.localhost:4100`] })
    .listen(port, '127.0.0.1', () => console.log(`Issue coordination acceptance http://localhost:${port}; data=${root}`));
}
