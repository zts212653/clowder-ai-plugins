import { createServer } from 'node:http';

const mrUrl = 'https://internal.example/team/core/-/merge_requests/2';
function mergeRoute(state, method, payload, url = mrUrl, ignoreLinks = false) {
  if (method === 'PUT' && !ignoreLinks) state.description = payload.description;
  return {
    description: state.description,
    web_url: url,
    sha: state.mismatch ? 'wrong' : 'head',
    source_branch: 'sync/key',
    target_branch: 'main',
    state: 'opened',
  };
}
function issueRoute(state, path, method, payload) {
  if (method === 'POST')
    state.issue = {
      iid: 7,
      web_url: 'https://internal.example/team/core/-/issues/7',
      state: 'opened',
      description: payload.description,
    };
  if (method === 'PUT') state.issue.state = payload.state_event === 'close' ? 'closed' : 'opened';
  if (!path.endsWith('/issues') || method !== 'GET') return state.issue;
  if (!state.issue) return [];
  return state.duplicate ? [state.issue, state.issue] : [state.issue];
}
export async function gitlabPlatform(options = {}) {
  const currentMrUrl = options.legacy ? mrUrl.replace('/-/', '/') : mrUrl;
  const state = { description: '', writes: 0, mismatch: false, denied: false, duplicate: false, requests: [] };
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Next-Page', '');
    if (state.denied) {
      res.statusCode = 403;
      return res.end(JSON.stringify({ secret: 'PRIVATE_DO_NOT_RECORD' }));
    }
    let input = '';
    for await (const c of req) input += c;
    const payload = input ? JSON.parse(input) : {},
      path = new URL(req.url, 'http://localhost').pathname;
    state.requests.push({ path, method: req.method });
    if (req.method !== 'GET') state.writes++;
    if (path.endsWith('/related_merge_requests')) {
      if (options.relatedUnsupported) {
        res.statusCode = 405;
        return res.end();
      }
      return res.end(
        JSON.stringify(state.description.includes('[repo-sync-link:key:2]') ? [{ web_url: currentMrUrl }] : []),
      );
    }
    let result = path.endsWith('/merge_requests/2')
      ? mergeRoute(state, req.method, payload, currentMrUrl, options.ignoreLinks)
      : issueRoute(state, path, req.method, payload);
    if (options.envelope && path.endsWith('/issues') && req.method === 'GET')
      result = { opened: result.length, closed: 0, all: result.length, issues: result };
    res.end(JSON.stringify(result));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  process.env.REPO_SYNC_TEST_TOKEN = 'test-local-secret';
  const config = {
    allowLocal: true,
    internalWebUrl: 'https://internal.example/team/core',
    issues: {
      mode: 'gitlab',
      apiUrl: `http://127.0.0.1:${server.address().port}/api/v4`,
      projectId: 'team/core',
      tokenEnv: 'REPO_SYNC_TEST_TOKEN',
    },
  };
  const request = {
    sourceId: 'source',
    key: 'key',
    repository: config.internalWebUrl,
    issue: { title: 'source title', body: 'source body', url: 'https://github.com/demo/core/issues/1' },
  };
  return {
    config,
    request,
    writes: () => state.writes,
    requests: state.requests,
    mrDescription: () => state.description,
    description: (value) => {
      state.description = value;
    },
    issue: (value) => Object.assign(state.issue, value),
    mismatch: () => {
      state.mismatch = true;
    },
    denied: () => {
      state.denied = true;
    },
    duplicate: () => {
      state.duplicate = true;
    },
    close: async () => {
      await new Promise((done) => server.close(done));
    },
  };
}
