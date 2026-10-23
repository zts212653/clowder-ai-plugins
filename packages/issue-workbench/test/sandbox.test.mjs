import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Use separate Node processes: an in-process recreation cannot prove recovery
// without module globals or cached objects from the previous run.
async function launchSandbox(options) {
  const moduleUrl = new URL('../scripts/sandbox/server.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { startSandbox } = await import(${JSON.stringify(moduleUrl)});
    const app = await startSandbox(JSON.parse(process.env.SANDBOX_TEST_OPTIONS));
    process.once('SIGTERM', async () => { await app.close(); process.exit(0); });
    process.send({ url: app.url });
  `], { env: { ...process.env, SANDBOX_TEST_OPTIONS: JSON.stringify(options) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '', stopped = false;
  child.stderr.on('data', bytes => { stderr += bytes; });
  const exited = new Promise(resolve => { child.once('exit', code => { stopped = true; resolve(code); }); });
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Sandbox start timed out: ' + stderr)), 30000);
      child.once('message', message => { clearTimeout(timer); resolve(message.url); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error('Sandbox exited ' + code + ': ' + stderr)); });
    });
    return { url, close: async () => {
      if (stopped) return;
      child.kill('SIGTERM');
      assert.equal(await exited, 0, stderr);
    } };
  } catch (error) { child.kill('SIGTERM'); throw error; }
}

test('interactive sandbox retains real plugin state across two accounts and separate process restart', { timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'issue-interactive-test-'));
  const options = { root, hostRoot: process.env.ISSUE_WORKBENCH_HOST_ROOT,
    archive: process.env.ISSUE_WORKBENCH_HOST_ARCHIVE, port: 0, automatic: false };
  let app = await launchSandbox(options);
  t.after(async () => app.close());
  const stateResponse = await fetch(app.url + '/sandbox/state');
  assert.equal(stateResponse.status, 200, 'The user must have a live interactive control surface');
  assert.equal((await stateResponse.json()).mode, 'isolated-simulation');
  const action = async (actor, method, payload = {}, confirmed = false) => {
    const r = await fetch(app.url + '/' + actor + '/api/plugins/dev.clowder.issue-workbench/actions/teamWorkbench/' + method,
      { method: 'POST', headers: { 'content-type': 'application/json', ...(confirmed ? { 'x-cat-cafe-owner-confirmed': 'true' } : {}) },
        body: JSON.stringify({ payload: JSON.stringify(payload) }) });
    const value = await r.json(); assert.equal(r.status, 200, JSON.stringify(value)); return value.data;
  };
  const control = async body => {
    const r = await fetch(app.url + '/sandbox/control', { method: 'POST', headers: { 'content-type': 'application/json', 'x-issue-sandbox': 'simulation' }, body: JSON.stringify(body) });
    const value = await r.json(); assert.equal(r.status, 200, JSON.stringify(value)); return value;
  };
  const savedPlan = 'Process restart sentinel 8ac4: retain this authored plan.';
  const value = { ref: { sourceId: 'sandbox-github', issueId: 'I_sandbox_1', number: 1 },
    title: 'Issue 1', sourceVersion: '2026-10-21T00:00:00Z', scope: 'unknown',
    module: '', tags: '', notes: '', evidence: '', branch: '', base: '', patch: savedPlan,
    taskUrl: '', adoption: 'pending', verification: 'pending', verificationEvidence: '', labelDraft: '' };
  const saved = await fetch(app.url + '/sender/api/issue-coordination/work', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-issue-coordination': 'local-work' },
    body: JSON.stringify({ value, expectedRevision: 0 }) });
  assert.equal(saved.status, 200, await saved.text());
  const start = await action('sender', 'summary', { repo: 'fixture/repo', number: 1 });
  assert.deepEqual(start.issueContext.assignmentOptions.members, ['alice', 'bob']);
  const job = await action('sender', 'analyze', { repo: 'fixture/repo', number: 1, requestId: 'manual-sentinel-analysis' });
  await control({ action: 'tick' });
  assert.ok((await action('sender', 'get', { id: job.id })).analysis);
  await action('sender', 'assignIssue', { repo: 'fixture/repo', number: 1, sourceVersion: start.issueContext.sourceVersion,
    requestId: 'manual-sentinel-invite', login: 'alice', delivery: 'invitation' }, true);
  await control({ action: 'tick' });
  const inbox = (await action('receiver', 'summary', { kind: 'inbox' })).rows;
  assert.equal(inbox.length, 1);
  await control({ action: 'report', actor: 'receiver', id: inbox[0].id, status: 'accepted', summary: 'A stranger accepts 47b2' });
  assert.equal((await action('receiver', 'get', { id: inbox[0].id })).sharedReceipts[0].summary, 'A stranger accepts 47b2');
  await app.close(); app = await launchSandbox(options);
  const readWork = async actor => (await (await fetch(app.url + '/' + actor + '/api/issue-coordination/state')).json()).sources[0].work;
  assert.equal((await readWork('sender'))[0].value.patch, savedPlan);
  assert.deepEqual(await readWork('receiver'), [], 'Two members must not share local drafts or plans');
  assert.equal((await action('receiver', 'summary', { kind: 'inbox' })).rows[0].id, inbox[0].id);
  assert.equal((await action('receiver', 'get', { id: inbox[0].id })).sharedReceipts[0].summary, 'A stranger accepts 47b2');
  assert.equal((await action('sender', 'get', { id: job.id })).analysis.score, 9);
  // A deliberately derived local test archive exercises same-version replacement.
  // This fixture is not represented as the shipped candidate's byte identity.
  const replacement = await mkdtemp(join(tmpdir(), 'issue-sandbox-upgrade-'));
  execFileSync('tar', ['-xzf', options.archive, '-C', replacement]);
  await appendFile(join(replacement, 'package/README.md'), '\nSandbox replacement test fixture.\n');
  const nextArchive = join(replacement, 'replacement.tgz');
  execFileSync('tar', ['-czf', nextArchive, '-C', replacement, 'package']);
  await app.close();
  await assert.rejects(launchSandbox({ ...options, archive: nextArchive }), /different archive/);
  app = await launchSandbox({ ...options, archive: nextArchive, allowArchiveUpgrade: true });
  assert.equal((await readWork('sender'))[0].value.patch, savedPlan);
  assert.equal((await action('sender', 'get', { id: job.id })).analysis.score, 9);
  assert.equal((await action('receiver', 'get', { id: inbox[0].id })).sharedReceipts[0].summary, 'A stranger accepts 47b2');
  await control({ action: 'mode', value: 'failure' });
  const failure = await action('sender', 'analyze', { repo: 'fixture/repo', number: 2, requestId: 'failed-cat' });
  assert.equal(failure.status, 'pending');
  assert.ok(failure.error);
  await control({ action: 'mode', value: 'success' });
  await action('sender', 'retry', { id: failure.id });
  await control({ action: 'tick' });
  assert.equal((await action('sender', 'get', { id: failure.id })).analysis.score, 5);
  await control({ action: 'mode', value: 'timeout' });
  const waiting = await action('sender', 'analyze', { repo: 'fixture/repo', number: 3, requestId: 'waiting-cat' });
  await control({ action: 'tick' });
  assert.equal((await action('sender', 'get', { id: waiting.id })).status, 'delivered');
  await control({ action: 'mode', value: 'success' });
  await control({ action: 'tick' });
  assert.equal((await action('sender', 'get', { id: waiting.id })).analysis.score, 3);
  await control({ action: 'network', offline: true });
  const offline = await control({ action: 'tick' });
  assert.equal(offline.offline, true);
  assert.equal(offline.comments.length, 2, 'Offline synchronization must retain the invitation and explicit receipt');
  await control({ action: 'network', offline: false });
  await control({ action: 'tick' });
  assert.equal((await action('receiver', 'get', { id: inbox[0].id })).sharedReceipts[0].summary, 'A stranger accepts 47b2');
  await control({ action: 'enabled', actor: 'receiver', enabled: false });
  assert.equal((await control({ action: 'tick' })).participants.receiver.enabled, false);
  await control({ action: 'enabled', actor: 'receiver', enabled: true });
  await control({ action: 'source', number: 1, state: 'closed' });
  await control({ action: 'tick' });
  assert.equal((await action('receiver', 'summary', { kind: 'inbox' })).rows[0].status, 'inactive');
  const denied = await fetch(app.url + '/sandbox/control', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://untrusted.invalid' }, body: JSON.stringify({ action: 'tick' }) });
  assert.equal(denied.status, 403);
  t.diagnostic('Separate process and Redis restart retained plans, analysis and receipts: ' + root);
});
