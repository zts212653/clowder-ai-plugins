import { createServer } from 'node:http';
import { git } from '../src/process.mjs';

const lostResponse = Symbol('lost response');
export async function codehubPlatform(f, options = {}) {
  const state = {
      issues: [],
      mrs: [],
      creates: { issues: 0, prs: 0 },
      denied: false,
      links: 0,
      closes: 0,
      prCloses: 0,
      merges: 0,
      requests: [],
      errors: [],
      lost: options.lost,
    },
    web = 'https://codehub.example/innersource/team_G/core',
    token = 'SYNTHETIC_BROWSER_TOKEN';
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Next-Page', '');
    if (req.headers['private-token'] !== token || state.denied) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ message: 'unauthorized' }));
    }
    let text = '';
    for await (const data of req) text += data;
    const path = new URL(req.url, 'http://localhost').pathname,
      value = text ? JSON.parse(text) : null;
    state.requests.push(`${req.method} ${path}`);
    if (
      state.mergePending &&
      state.failReadback &&
      req.method === 'GET' &&
      path.endsWith('/merge_requests')
    ) {
      state.failReadback = false;
      res.statusCode = 503;
      return res.end('{}');
    }
    try {
      const result = await route(state, f, web, req, value, path, res, options);
      if (result === lostResponse) return res.destroy();
      res.end(JSON.stringify(result));
    } catch (error) {
      state.errors.push(error.message);
      res.statusCode = 500;
      res.end('{}');
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return {
    web,
    token,
    state,
    api: `http://127.0.0.1:${server.address().port}/api/v4`,
    close: () => new Promise((done) => server.close(done)),
  };
}
function loseOnce(state, kind, result) {
  if (state.lost !== kind) return result;
  state.lost = null;
  return lostResponse;
}
async function route(state, f, web, req, value, path, res, options) {
  if (path.endsWith('/related_merge_requests')) {
    res.statusCode = 405;
    return { message: 'Method Not Allowed' };
  }
  const mrMatch = /\/merge_requests\/(\d+)(?:\/merge)?$/.exec(path),
    issueMatch = /\/issues\/(\d+)$/.exec(path);
  if (mrMatch) {
    const mr = state.mrs.find((item) => String(item.iid) === mrMatch[1]);
    if (path.endsWith('/merge')) {
      if (value.sha !== mr.sha || state.conflicts || state.denyMerge) {
        res.statusCode = 405;
        return { message: 'merge rules rejected' };
      }
      if (state.deferMerge) {
        state.mergePending = true;
        return mr;
      }
      await f.merge({ branch: mr.source_branch, candidate: mr.sha });
      mr.state = 'merged';
      state.merges++;
      return loseOnce(state, 'merge', mr);
    }
    if (req.method === 'PUT') {
      if (value.state_event === 'close') {
        mr.state = 'closed';
        state.prCloses++;
        return loseOnce(state, 'pr-close', mr);
      }
      mr.description = value.description;
      state.links++;
      return loseOnce(state, 'link', mr);
    }
    return { ...mr, has_conflicts: state.conflicts ?? false };
  }
  if (issueMatch) {
    const issue = state.issues.find((item) => String(item.iid) === issueMatch[1]);
    if (req.method === 'PUT') {
      issue.state = value.state_event === 'close' ? 'closed' : 'opened';
      if (value.state_event === 'close') state.closes++;
      return loseOnce(state, 'close', issue);
    }
    return issue;
  }
  if (path.endsWith('/merge_requests')) return mergeCollection(state, f, web, req, value);
  if (path.endsWith('/issues')) return issueCollection(state, web, req, value, res, options);
  return {
    id: 5,
    web_url: web,
    path_with_namespace: 'innersource/team_G/core',
    default_branch: 'main',
    issues_enabled: true,
    merge_requests_enabled: true,
  };
}
async function mergeCollection(state, f, web, req, value) {
  if (req.method === 'POST') {
    const iid = ++state.creates.prs,
      mr = {
        iid,
        web_url: `${web}/merge_requests/${iid}`,
        description: value.description,
        source_branch: value.source_branch,
        target_branch: value.target_branch,
        state: 'opened',
        sha: (await git(f.internal, ['rev-parse', `refs/heads/${value.source_branch}`])).trim(),
        diff_refs: {
          base_sha: (await git(f.internal, ['rev-parse', 'refs/heads/main'])).trim(),
        },
      };
    mr.merge_status = 'can_be_merged';
    mr.head_pipeline = {
      id: iid,
      sha: mr.sha,
      status: state.pipelineStatus ?? 'success',
    };
    state.mrs.push(mr);
    return loseOnce(state, 'pr-create', mr);
  }
  const branch = new URL(req.url, 'http://localhost').searchParams.get('source_branch');
  return state.mrs.filter((mr) => !branch || mr.source_branch === branch);
}
function issueCollection(state, web, req, value, res, options) {
  if (req.method === 'POST') {
    const iid = ++state.creates.issues,
      issue = {
        iid,
        web_url: `${web}/issues/${iid}`,
        description: value.description,
        state: 'opened',
      };
    state.issues.push(issue);
    return loseOnce(state, 'issue', issue);
  }
  const params = new URL(req.url, 'http://localhost').searchParams,
    search = params.get('search'),
    issues = state.issues.filter((issue) => !search || issue.description.includes(search)),
    size = options.pageSize ?? 100,
    page = Number(params.get('page') ?? 1),
    start = (page - 1) * size;
  if (start + size < issues.length) res.setHeader('X-Next-Page', String(page + 1));
  return {
    opened: issues.filter((issue) => issue.state === 'opened').length,
    closed: issues.filter((issue) => issue.state === 'closed').length,
    all: issues.length,
    issues: issues.slice(start, start + size),
  };
}
