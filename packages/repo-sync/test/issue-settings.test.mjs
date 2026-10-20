import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createConnection } from '../src/connections.mjs';
import { Receiver } from '../src/engine.mjs';
import { publicIssues } from '../src/issue-adapter.mjs';
import { issueConfiguration } from '../src/issue-settings.mjs';
import { repositories } from './fixtures.mjs';
import { issuePlatform } from './issue-fixtures.mjs';

test('an adopted binding can enable Issue API without resetting its baseline or accepting executable web input', async () => {
  const f = await repositories(),
    folder = await mkdtemp(join(tmpdir(), 'repo-sync-issue-config-'));
  const file = join(folder, 'config.json');
  await writeFile(file, JSON.stringify({ ...f.config, internalWebUrl: 'https://internal.example/core' }));
  const connection = await createConnection(file),
    receiver = await connection.current();
  await receiver.adopt(f.u0, f.i0);
  const initial = (await receiver.status()).initial;
  const input = {
    action: 'configure-issues',
    expectedRevision: connection.describe().revision,
    issueMode: 'gitlab',
    issueApiUrl: 'https://internal.example/api/v4',
    issueProjectId: '1',
    issueTokenEnv: 'INTERNAL_TOKEN',
  };
  await connection.run(input);
  const next = await connection.current();
  assert.deepEqual((await next.status()).initial, initial);
  assert.equal(publicIssues(next.config).automatic, true);
  await assert.rejects(
    () => connection.run({ ...input, expectedRevision: connection.describe().revision, command: 'bad' }),
    { code: 'CONFIGURATION_CHANGED' },
  );
});
test('Issue creation intention freezes adapter and repository settings instead of silently switching to manual mode', async () => {
  const f = await repositories(),
    platform = await issuePlatform(f),
    folder = await mkdtemp(join(tmpdir(), 'repo-sync-issue-config-'));
  const file = join(folder, 'config.json');
  await writeFile(
    file,
    JSON.stringify({ ...f.config, internalWebUrl: 'https://internal.example/core', issues: platform.config }),
  );
  const connection = await createConnection(file),
    receiver = await connection.current();
  await receiver.adopt(f.u0, f.i0);
  await receiver.setQueue(f.plans);
  await receiver.start();
  await receiver.syncIssues();
  const before = await readFile(file, 'utf8');
  await assert.rejects(
    () =>
      connection.run({
        action: 'configure-issues',
        expectedRevision: connection.describe().revision,
        issueMode: 'manual',
      }),
    { code: 'ISSUE_CONFIG_FROZEN' },
  );
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal((await platform.read()).creates, 1);
  assert.equal(publicIssues(receiver.config).command, undefined);
});
test('corrupted Issue intent is preserved and cannot be interpreted as an unused creation request', async () => {
  const f = await repositories(),
    platform = await issuePlatform(f);
  const receiver = new Receiver({
    ...f.config,
    internalWebUrl: 'https://internal.example/core',
    issues: platform.config,
  });
  await receiver.adopt(f.u0, f.i0);
  await receiver.setQueue(f.plans);
  await receiver.start();
  const state = await receiver.read();
  state.issueIntents = null;
  await writeFile(receiver.store.path, JSON.stringify(state));
  const before = await readFile(receiver.store.path, 'utf8');
  await assert.rejects(() => receiver.syncIssues(), { code: 'LEDGER_INVALID' });
  assert.equal(await readFile(receiver.store.path, 'utf8'), before);
  assert.equal((await platform.read()).creates, 0);
});

test('a failed initial lookup does not freeze incorrect adapter configuration before any create intention', async () => {
  const f = await repositories(),
    platform = await issuePlatform(f),
    folder = await mkdtemp(join(tmpdir(), 'repo-sync-issue-config-'));
  const file = join(folder, 'config.json');
  await writeFile(
    file,
    JSON.stringify({ ...f.config, internalWebUrl: 'https://internal.example/core', issues: platform.config }),
  );
  const connection = await createConnection(file),
    receiver = await connection.current();
  await receiver.adopt(f.u0, f.i0);
  await receiver.setQueue(f.plans);
  await receiver.start();
  await platform.edit({ failFind: true });
  await assert.rejects(() => receiver.syncIssues(), { code: 'ISSUE_ADAPTER_UNAVAILABLE' });
  assert.equal((await receiver.status()).issueAdapterId, undefined);
  await connection.run({
    action: 'configure-issues',
    expectedRevision: connection.describe().revision,
    issueMode: 'gitlab',
    issueApiUrl: 'https://internal.example/api/v4',
    issueProjectId: '1',
    issueTokenEnv: 'CORRECT_TOKEN',
  });
  assert.equal((await connection.current()).config.issues.tokenEnv, 'CORRECT_TOKEN');
  assert.equal((await platform.read()).creates, 0);
});

test('an adopted project can confirm the closure rule without changing its original baseline, active ID or candidate', async () => {
  const f = await repositories(),
    folder = await mkdtemp(join(tmpdir(), 'repo-sync-closure-')),
    file = join(folder, 'config.json');
  await writeFile(file, JSON.stringify({ ...f.config, commitClosureVerified: false }));
  const connection = await createConnection(file),
    receiver = await connection.current();
  await receiver.adopt(f.u0, f.i0);
  await receiver.setQueue(f.plans);
  await receiver.start();
  const before = await receiver.read();
  await assert.rejects(
    () =>
      connection.run({
        action: 'configure-closure',
        expectedRevision: connection.describe().revision,
        confirmed: false,
      }),
    { code: 'CLOSURE_CONFIRMATION_REQUIRED' },
  );
  await connection.run({
    action: 'configure-closure',
    expectedRevision: connection.describe().revision,
    confirmed: true,
  });
  const next = await connection.current(),
    after = await next.read();
  assert.equal(next.config.commitClosureVerified, true);
  assert.equal(after.activeId, before.activeId);
  assert.equal(Object.hasOwn(after, 'active'), false);
  assert.deepEqual(after.initial, before.initial);
  assert.deepEqual(after.accepted, before.accepted);
  assert.equal(after.deliveries[0].candidate, before.deliveries[0].candidate);
  assert.equal(after.deliveries[0].configurations.at(-1).snapshot.commitClosureVerified, true);
});

test('compatible Issue links infer a project path; other platform links never silently become GitLab APIs', () => {
  const config = { internalWebUrl: 'https://internal.example/team/core' };
  assert.deepEqual(
    issueConfiguration(config, {
      issueMode: 'gitlab',
      issuePageUrl: 'https://internal.example/team/core/-/issues/7',
      issueAuthMode: 'session',
    }),
    { mode: 'gitlab', apiUrl: 'https://internal.example/api/v4', projectId: 'team/core', authMode: 'session' },
  );
  assert.throws(
    () =>
      issueConfiguration(config, {
        issueMode: 'gitlab',
        issuePageUrl: 'https://internal.example/projectman/scrum/uuid/task/detail/7',
        issueAuthMode: 'session',
      }),
    { code: 'ISSUE_API_UNSUPPORTED' },
  );
  assert.throws(
    () =>
      issueConfiguration(config, {
        issueMode: 'gitlab',
        issuePageUrl: 'https://other.example/team/core/issues/7',
        issueAuthMode: 'session',
      }),
    { code: 'ISSUE_API_UNSUPPORTED' },
  );
});
