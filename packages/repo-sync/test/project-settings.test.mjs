import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createConnection } from '../src/connections.mjs';
import { projectConfiguration } from '../src/project-settings.mjs';
import { createReceiverServer } from '../src/server.mjs';
import { enabledSettings } from '../web/settings-view.mjs';
import { codehubPlatform } from './codehub-fixture.mjs';
import { repositories } from './fixtures.mjs';

globalThis.location = new URL('http://localhost/');
const { workbench } = await import('../web/workbench.mjs');

test('unified settings preserve binding, reject stale/frozen changes and keep Token out of files and tasks', async (t) => {
  const f = await repositories(),
    p = await codehubPlatform(f);
  t.after(p.close);
  const adapter = {
    mode: 'gitlab',
    apiUrl: p.api,
    projectId: 'team/core',
    authMode: 'session',
  };
  const file = join(await mkdtemp(join(tmpdir(), 'repo-sync-settings-')), 'config.json');
  await writeFile(
    file,
    JSON.stringify({
      ...f.config,
      internalWebUrl: p.web,
      pullRequests: adapter,
      issues: adapter,
    }),
  );
  const connection = await createConnection(file);
  const receiver = await connection.current();
  await receiver.adopt(f.u0, f.i0);
  const server = createReceiverServer(null, { connection });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  const status = await (await fetch(`${base}/api/status`)).json();
  const input = {
    expectedBinding: status.config.bindingId,
    expectedRevision: status.connection.revision,
    issueToken: p.token,
    autoMergeWaitMs: 60000,
  };
  const post = (value) =>
    fetch(`${base}/api/project-settings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Repo-Sync-Token': status.token,
      },
      body: JSON.stringify(value),
    });
  const saved = await (await post(input)).json();
  assert.equal(saved.saved, true);
  assert.ok(saved.checks.every((c) => c.status === 'DONE'));
  assert.equal((await post(input)).status, 409, 'stale configuration cannot save twice');
  const fresh = await (await fetch(`${base}/api/status`)).json();
  assert.equal(fresh.config.autoMergeWaitMs, 60000);
  assert.equal(fresh.config.bindingId, status.config.bindingId);
  assert.equal(fresh.operation, null);
  assert.doesNotMatch(await readFile(file, 'utf8'), /SYNTHETIC_BROWSER_TOKEN/);
  assert.deepEqual((await (await connection.current()).status()).accepted, status.state.accepted);
  const previous = (await connection.current()).config;
  assert.throws(() => projectConfiguration(previous, { active: {} }, { commitStrategy: 'rewrite' }), {
    code: 'COMMIT_POLICY_FROZEN',
  });
  assert.throws(() => projectConfiguration(previous, {}, { sourceUrl: 'other' }), {
    code: 'INVALID_CONFIGURATION_INPUT',
  });
});
test('enabled configuration contains one save form, frozen values and no task window or initialization wizard', () => {
  const c = {
    bindingId: 'a',
    mode: 'continuous',
    prTransport: 'gitlab',
    sourceUrl: 'https://github.com/demo/core',
    internalUrl: 'git@example:core',
    sourceBranch: 'main',
    targetBranch: 'main',
    receivingIdentity: {
      name: 'Internal Name',
      email: 'internal@example.invalid',
    },
  };
  const snapshot = {
    config: c,
    connection: { revision: 'r' },
    sourceAuthentication: {},
    state: {
      initial: { upstream: 'a', internal: 'b' },
      accepted: { upstream: 'a', internal: 'b' },
      active: {},
      automation: {},
    },
  };
  const html = enabledSettings(snapshot);
  assert.match(html, /Internal Name/);
  assert.match(html, /当前交付未完成/);
  assert.equal((html.match(/<form /g) ?? []).length, 1);
  assert.equal((html.match(/name="issueToken"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /id="operation"|配置已完成|flow setup|Git 推送时自动创建 PR/);
});

test('settings explain round lock and keep auth actions beside their inputs', () => {
  const html = enabledSettings({
    config: { ...{
      bindingId: 'a', mode: 'continuous', prTransport: 'gitlab',
      sourceUrl: 'https://github.com/demo/core', internalUrl: 'git@example:core',
      sourceBranch: 'main', targetBranch: 'main', internalWebUrl: 'https://codehub.example/core',
    } },
    connection: { revision: 'r' }, sourceAuthentication: { available: false, verified: false },
    state: { initial: { upstream: 'a', internal: 'b' }, accepted: { upstream: 'a', internal: 'b' },
      active: null, queue: [{ target: 'queued' }], automation: { status: 'PAUSED' } },
  });
  assert.match(html, /本轮还有 1 笔待处理/);
  assert.match(html, /data-auth-provide="issue"/);
  assert.match(html, /data-auth-verify="github"/);
  assert.doesNotMatch(html, /保存设置并验证\s*Token/);
});

test('workbench keeps GitHub credential entry in settings instead of duplicating it', () => {
  const html = workbench(
    {
      config: {
        bindingId: 'a', mode: 'continuous', prTransport: 'gitlab',
        sourceUrl: 'https://github.com/demo/core', internalUrl: 'git@example:core',
        sourceBranch: 'main', targetBranch: 'main', internalWebUrl: 'https://codehub.example/core',
      },
      state: {
        initial: { upstream: 'a', internal: 'b' }, accepted: { upstream: 'a', internal: 'b' },
        active: null, queue: [], automation: { status: 'COMPLETE' }, deliveryCount: 0,
        scannedAt: null, latest: 'a', syncTarget: null,
      },
      sourceAuthentication: { available: false, verified: false }, connection: { revision: 'r' }, token: 'x',
    },
    { selected: 'current', detail: null, page: { total: 0, records: [], offset: 0 }, filters: { q: '', status: 'all', from: '', to: '' } },
    [],
    false,
  );
  assert.equal((html.match(/name="githubToken"/g) ?? []).length, 0);
  assert.match(html, /data-auth-focus="github"/);
});

test('manual PR mode does not require internal API authentication', () => {
  const html = enabledSettings({
    config: {
      bindingId: 'a', mode: 'version', prTransport: 'manual', sourceUrl: 'https://github.com/demo/core',
      internalUrl: 'git@example:core', sourceBranch: 'main', targetBranch: 'main', internalWebUrl: 'https://codehub.example/core',
      internalPaths: [],
    },
    connection: { revision: 'r' }, sourceAuthentication: {},
    state: {
      initial: { upstream: 'a', internal: 'b' }, accepted: { upstream: 'a', internal: 'b' },
      active: null, queue: [], deliveries: [], automation: { status: 'COMPLETE' },
    },
  });
  assert.match(html, /data-platform-auth hidden/);
  assert.match(html, /当前为手工 PR \/ Issue 登记，不需要内部平台 API Token/);
});

test('selected tag keeps commit policy editable until synchronization starts', () => {
  const html = enabledSettings({
    config: {
      bindingId: 'a', mode: 'version', prTransport: 'manual', sourceUrl: 'https://github.com/demo/core',
      internalUrl: 'git@example:core', sourceBranch: 'main', targetBranch: 'main', internalWebUrl: 'https://codehub.example/core',
      internalPaths: [],
    },
    connection: { revision: 'r' }, sourceAuthentication: {},
    state: {
      initial: { upstream: 'a', internal: 'b' }, accepted: { upstream: 'a', internal: 'b' },
      active: null, queue: [{ target: 'tag-v1' }], deliveries: [], automation: { status: 'COMPLETE' },
    },
  });
  const policy = html.slice(html.indexOf('<h3>提交与接收策略</h3>'), html.indexOf('<section class="settings-result"'));
  assert.match(policy, /目标已选定，但同步尚未启动/);
  assert.doesNotMatch(policy, /<fieldset disabled>/);
});
