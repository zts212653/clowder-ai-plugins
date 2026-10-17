import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { Receiver } from '../src/engine.mjs';
import { git } from '../src/process.mjs';
import { repositories } from './fixtures.mjs';

async function fixture() {
  const f = await repositories();
  let mr = null,
    creates = 0,
    lost = false,
    duplicate = false,
    mismatch = false;
  async function createMr(req) {
    let text = '';
    for await (const data of req) text += data;
    const value = JSON.parse(text);
    creates++;
    mr = {
      iid: 2,
      web_url: 'https://internal.example/team/core/merge_requests/2',
      source_branch: value.source_branch,
      target_branch: value.target_branch,
      sha: (await git(f.internal, ['rev-parse', `refs/heads/${value.source_branch}`])).trim(),
      diff_refs: { base_sha: f.i0 },
      description: value.description,
      state: 'opened',
    };
  }
  function readMr(path) {
    if (path.endsWith('/merge_requests')) return mr ? (duplicate ? [mr, mr] : [mr]) : [];
    return mr ? { ...mr, ...(mismatch ? { sha: 'wrong' } : {}) } : null;
  }
  const api = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Next-Page', '');
    if (req.method === 'POST') {
      await createMr(req);
      if (lost) return res.destroy();
      res.end(JSON.stringify(mr));
    } else res.end(JSON.stringify(readMr(path)));
  });
  await new Promise((done) => api.listen(0, '127.0.0.1', done));
  process.env.REPO_SYNC_PR_TEST_TOKEN = 'synthetic-api-secret';
  const config = {
    ...f.config,
    internalWebUrl: 'https://internal.example/team/core',
    pullRequests: {
      mode: 'gitlab',
      apiUrl: `http://127.0.0.1:${api.address().port}/api/v4`,
      projectId: 'team/core',
      tokenEnv: 'REPO_SYNC_PR_TEST_TOKEN',
    },
  };
  let receiver;
  try {
    receiver = new Receiver(config);
    await receiver.adopt(f.u0, f.i0);
    await receiver.setQueue(f.plans);
    await receiver.start();
    await receiver.linkIssue('issue-71', '19', 'https://internal.example/team/core/issues/19');
  } catch (error) {
    await new Promise((done) => api.close(done));
    throw error;
  }
  return {
    f,
    receiver,
    config,
    creates: () => creates,
    lose: () => {
      lost = true;
    },
    duplicate: () => {
      duplicate = true;
    },
    mismatch: () => {
      mismatch = true;
    },
    close: () => new Promise((done) => api.close(done)),
  };
}
test('built-in API creates one MR during preparation and validates its exact Git candidate with legacy web paths', async () => {
  const p = await fixture();
  try {
    await p.receiver.prepare();
    const state = await p.receiver.status();
    assert.equal(state.active.status, 'WAITING_APPROVAL');
    assert.equal(state.active.prUrl, 'https://internal.example/team/core/merge_requests/2');
    assert.equal(p.creates(), 1);
    assert.equal((await git(p.f.internal, ['rev-parse', 'refs/heads/main'])).trim(), p.f.i0);
    await p.receiver.createPr();
    assert.equal(p.creates(), 1);
  } finally {
    await p.close();
  }
});
test('lost API create receipt resumes by finding the same MR across a new Receiver, never recreates', async () => {
  const p = await fixture();
  try {
    p.lose();
    await assert.rejects(() => p.receiver.prepare(), { code: 'PR_API_UNAVAILABLE' });
    assert.equal(p.creates(), 1);
    const restarted = new Receiver(p.config);
    await restarted.createPr();
    assert.equal((await restarted.status()).active.status, 'WAITING_APPROVAL');
    assert.equal(p.creates(), 1);
  } finally {
    await p.close();
  }
});
test('duplicate or changed MR results cannot overwrite the original mapping or create another MR', async () => {
  const p = await fixture();
  try {
    await p.receiver.prepare();
    p.duplicate();
    await assert.rejects(() => p.receiver.createPr(), { code: 'PR_OBJECT_MISMATCH' });
    assert.equal(p.creates(), 1);
    assert.equal((await p.receiver.status()).active.prUrl, 'https://internal.example/team/core/merge_requests/2');
  } finally {
    await p.close();
  }
});

test('a changed MR head is rejected while retaining the original PR and creation count', async () => {
  const p = await fixture();
  try {
    await p.receiver.prepare();
    p.mismatch();
    await assert.rejects(() => p.receiver.createPr(), { code: 'PR_OBJECT_MISMATCH' });
    assert.equal(p.creates(), 1);
    assert.equal((await p.receiver.status()).active.prUrl, 'https://internal.example/team/core/merge_requests/2');
  } finally {
    await p.close();
  }
});
