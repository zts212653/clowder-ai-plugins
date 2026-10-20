import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectWorkspace } from '../src/projects.mjs';
import { git } from '../src/process.mjs';
import { writePrivate } from '../src/private-config.mjs';
import { createReceiverServer } from '../src/server.mjs';
import { repositories } from './fixtures.mjs';

export async function migrationRuntime(t, lost) {
  const f = await repositories(),
    directory = await mkdtemp(join(tmpdir(), 'repo-sync-migration-source-'));
  const state = { issues: [], prs: [], issueCreates: 0, prCreates: 0, closes: 0, lost, errors: [] };
  const api = createServer(async (req, res) => {
    try {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-Next-Page', '');
      if (req.headers['private-token'] !== 'recipient-token' && req.headers['private-token'] !== 'source-token') {
        res.writeHead(401);
        res.end('{}');
        return;
      }
      let text = '';
      for await (const chunk of req) text += chunk;
      const input = text ? JSON.parse(text) : {},
        url = new URL(req.url, 'http://localhost');
      const route = url.pathname.split('/projects/team%2Fcore/')[1];
      let result;
      if (!route) result = { id: 1, web_url: 'https://internal.example/team/core', default_branch: 'main' };
      else if (route.startsWith('issues')) {
        if (route === 'issues' && req.method === 'POST') {
          state.issueCreates++;
          state.issues.push({
            iid: 7,
            web_url: 'https://internal.example/team/core/-/issues/7',
            state: 'opened',
            ...input,
          });
          if (state.lost === 'issue') {
            state.lost = null;
            res.destroy();
            return;
          }
        }
        if (route.endsWith('related_merge_requests'))
          result = state.prs.filter((p) => p.description.includes('[repo-sync-link:'));
        else if (route === 'issues') result = req.method === 'POST' ? state.issues[0] : state.issues;
        else {
          result = state.issues[0];
          if (req.method === 'PUT') {
            result.state = input.state_event === 'close' ? 'closed' : 'opened';
            state.closes++;
          }
        }
      } else if (route.startsWith('merge_requests')) {
        if (route === 'merge_requests' && req.method === 'POST') {
          state.prCreates++;
          state.prs.push({
            iid: state.prCreates,
            web_url: `https://internal.example/team/core/-/merge_requests/${state.prCreates}`,
            ...input,
            sha: await git(f.internal, ['rev-parse', `refs/heads/${input.source_branch}`]),
            diff_refs: { base_sha: await git(f.internal, ['rev-parse', 'refs/heads/main']) },
            state: 'opened',
          });
          if (state.lost === 'pr') {
            state.lost = null;
            res.destroy();
            return;
          }
        }
        result =
          route === 'merge_requests'
            ? state.prs.filter((p) => p.source_branch === url.searchParams.get('source_branch'))
            : state.prs.find((p) => String(p.iid) === route.split('/')[1]);
        if (req.method === 'PUT') result.description = input.description;
      }
      res.end(JSON.stringify(result));
    } catch (error) {
      state.errors.push(error.message);
      if (!res.headersSent) res.writeHead(500);
      res.end('{}');
    }
  });
  await new Promise((done) => api.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => api.close(done)));
  const adapter = {
    mode: 'gitlab',
    apiUrl: `http://127.0.0.1:${api.address().port}/api/v4`,
    projectId: 'team/core',
    authMode: 'session',
  };
  const config = {
    ...f.config,
    stateDir: join(directory, 'state'),
    checkProfile: 'git-integrity',
    checks: [{ command: 'git', args: ['fsck', '--no-reflogs'] }],
    issues: adapter,
    pullRequests: { ...adapter },
    internalWebUrl: 'https://internal.example/team/core',
    receivingIdentity: { name: 'Sync', email: 'sync@example.invalid' },
    commitStrategy: 'rewrite',
    configurationSource: 'workbench',
  };
  const file = join(directory, 'config.json');
  await writePrivate(file, config);
  const projects = await createProjectWorkspace(file, { allowLocalTransfers: true });
  const connection = await projects.connection(),
    receiver = await connection.current();
  await receiver.adopt(f.u0, f.i0);
  await receiver.setQueue(f.plans);
  const merge = async (delivery) => {
    const result = await f.merge(delivery);
    state.prs.find((p) => p.sha === delivery.candidate).state = 'merged';
    return result;
  };
  return { ...f, directory, file, projects, receiver, state, merge };
}

export async function workbenchServer(t, projects) {
  const server = createReceiverServer(null, {
    projects,
    syncInterval: 3600000,
    transferChecks: { verifySource: async () => {} },
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.shutdown());
  const url = `http://127.0.0.1:${server.address().port}`;
  const status = async (id = 'default') => fetch(`${url}/api/status?project=${id}`).then((r) => r.json());
  const request = async (path, value, id = 'default') => {
    const current = await status(id);
    const response = await fetch(`${url}${path}?project=${id}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Repo-Sync-Token': current.token,
      },
      body: JSON.stringify(value),
    });
    return { status: response.status, value: await response.json() };
  };
  const task = async (input, id = 'default') => {
    const current = await status(id),
      admitted = await request(
        '/api/tasks',
        {
          ...input,
          projectId: id,
          expectedBinding: current.config.bindingId,
          expectedRevision: current.connection.revision,
        },
        id,
      );
    assert.equal(admitted.status, 202, JSON.stringify(admitted.value));
    for (let i = 0; i < 2000; i++) {
      const task = (
        await fetch(`${url}/api/tasks/${input.requestId}?project=${id}`, {
          headers: {
            'X-Repo-Sync-Token': current.token,
          },
        }).then((r) => r.json())
      ).operation;
      if (!['RUNNING', 'CANCELLING'].includes(task?.status)) return task;
      await new Promise((done) => setTimeout(done, 20));
    }
    throw Error('migration task did not finish');
  };
  return { server, url, status, request, task };
}
