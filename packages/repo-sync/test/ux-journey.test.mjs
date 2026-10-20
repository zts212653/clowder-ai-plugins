import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatch } from '../src/actions.mjs';
import { Receiver } from '../src/engine.mjs';
import { git } from '../src/process.mjs';
import { configuration } from '../web/connections.mjs';
import { fileTree } from '../web/files.mjs';
import { button, esc, sha } from '../web/ui.mjs';
import { repositories } from './fixtures.mjs';
import { versionRepositories } from './version-fixtures.mjs';

test('documentation shortcuts filter real paths without selecting preservation rules', () => {
  const html = fileTree([], 'files', { rules: true });
  assert.match(html, /value="readme">查找 README/);
  assert.match(html, /value="documentation">查找文档/);
});

test('new connection requires an explicit goal and presents one compact setup route', () => {
  const html = configuration(
    { config: null, state: null, connection: { revision: null, editable: true } },
    esc,
    sha,
    button,
  );
  assert.match(html, /data-mode-cards/);
  assert.equal((html.match(/type="radio" name="mode" required/g) ?? []).length, 2);
  assert.doesNotMatch(html, /name="mode" required[^>]*checked/);
  assert.match(html, /保存并检查连接/);
  assert.match(html, /确认启用/);
});

test('baseline inspection resolves an annotated historical tag without adopting or modifying main', async () => {
  const f = await versionRepositories();
  const receiver = new Receiver(f.config);
  const before = await git(f.internal, ['rev-parse', 'main']);
  const report = await dispatch(receiver, { action: 'inspect-baseline', upstream: 'v1.0.0', internal: f.i0 });
  assert.equal(report.upstream, f.u0);
  assert.equal(report.valid, true);
  assert.ok(report.files.some((item) => item.path === 'core.txt' && item.kind === 'unchanged'));
  assert.ok(report.files.some((item) => item.path === 'README.md' && item.category === 'internal'));
  assert.equal(await receiver.status(), null);
  assert.equal(await git(f.internal, ['rev-parse', 'main']), before);
});

test('baseline inspection reports selectable core differences and still registers no baseline', async () => {
  const f = await versionRepositories();
  const receiver = new Receiver({ ...f.config, internalPaths: [] });
  const report = await dispatch(receiver, { action: 'inspect-baseline', upstream: f.u0, internal: f.i0 });
  assert.equal(report.valid, false);
  assert.ok(report.differences.some((item) => item.path === 'README.md' && item.blocking));
  assert.equal(await receiver.status(), null);
  await assert.rejects(dispatch(receiver, { action: 'inspect-baseline', upstream: f.u0, internal: f.u0 }), {
    code: 'STALE_INTERNAL_HEAD',
  });
});

test('optional synchronization preview performs no adoption, queue publication or remote writes', async () => {
  const f = await versionRepositories();
  const receiver = new Receiver(f.config);
  await receiver.adopt(f.u0, f.i0);
  const before = await receiver.read();
  const refs = await git(f.internal, ['show-ref']);
  const report = await dispatch(receiver, { action: 'preview-sync', tag: 'v2.0.0' });
  assert.equal(report.target, f.u1);
  assert.equal(report.plans.length, 1);
  assert.ok(report.changes.some((item) => item.path === 'core.txt'));
  assert.deepEqual(await receiver.read(), before);
  assert.equal(await git(f.internal, ['show-ref']), refs);
  assert.equal(report.readOnly, true);
});

async function processPreviewFixture() {
  const f = await repositories();
  const receiver = new Receiver({ ...f.config, sourceUrl: 'https://github.com/demo/core.git' });
  // Real local Git history with a controlled GitHub metadata contract, never a live platform.
  receiver.git.config = { ...receiver.config, sourceUrl: f.source };
  await receiver.adopt(f.u0, f.i0);
  const writes = [];
  const rejectWrite = (name) => async () => {
    writes.push(name);
    throw Object.assign(new Error('preview attempted a mutation'), { code: 'UNEXPECTED_WRITE' });
  };
  for (const name of ['prepare', 'createPr', 'syncIssues', 'linkPr', 'linkIssue', 'receipts'])
    receiver[name] = rejectWrite(name);
  for (const name of ['candidate', 'publish', 'checks']) receiver.git[name] = rejectWrite(`git.${name}`);
  const pr = {
    node_id: 'pr-1',
    number: 1,
    title: 'source PR',
    html_url: 'https://github.com/demo/core/pull/1',
    merged: true,
    merged_at: '2026-10-15T00:00:00Z',
    merge_commit_sha: f.u1,
    base: { ref: 'main' },
  };
  const provider = {
    api: async (path) => {
      if (path === 'repos/demo/core') return { node_id: 'fixture-repository-1' };
      if (path.includes('/commits/')) return path.includes(f.u1) ? [pr] : [];
      assert.equal(path, 'repos/demo/core/pulls/1');
      return pr;
    },
    collectIssues: async (_repository, source) => (source ? structuredClone(f.plans[0].issues) : []),
  };
  return { f, receiver, writes, provider };
}

test('process preview reads PR, Issue and direct-commit sources without changing ledger, refs or invoking write adapters', async () => {
  const { f, receiver, writes, provider } = await processPreviewFixture();
  const before = await receiver.read();
  const refs = await git(f.internal, ['show-ref']);
  const report = await dispatch(
    receiver,
    {
      action: 'preview-sync',
      targetKind: 'commit',
      targetValue: f.u2,
    },
    { sourceProvider: provider },
  );
  assert.equal(report.readOnly, true);
  assert.equal(report.target, f.u2);
  assert.deepEqual(
    report.plans.map((plan) => plan.source.kind),
    ['pr', 'commit'],
  );
  assert.equal(report.plans[0].issues[0].sourceId, 'issue-71');
  assert.deepEqual(await receiver.read(), before);
  assert.equal(await git(f.internal, ['show-ref']), refs);
  assert.deepEqual(writes, []);
});

test('process preview metadata failure after reading one source preserves the original ledger and internal refs', async () => {
  const { f, receiver, writes, provider } = await processPreviewFixture();
  const before = await receiver.read();
  const refs = await git(f.internal, ['show-ref']);
  let scanned = 0;
  const collect = provider.collectIssues;
  provider.collectIssues = async (...args) => {
    scanned += 1;
    if (scanned === 2) throw Object.assign(new Error('source metadata incomplete'), { code: 'METADATA_INCOMPLETE' });
    return collect(...args);
  };
  await assert.rejects(
    dispatch(
      receiver,
      {
        action: 'preview-sync',
        targetKind: 'commit',
        targetValue: f.u2,
      },
      { sourceProvider: provider },
    ),
    { code: 'METADATA_INCOMPLETE' },
  );
  assert.equal(scanned, 2, 'the failure occurs after the first source was read');
  assert.deepEqual(await receiver.read(), before);
  assert.equal(await git(f.internal, ['show-ref']), refs);
  assert.deepEqual(writes, []);
});

test('a paused admitted process round rejects previews even without an active delivery', async () => {
  const { f, receiver, writes, provider } = await processPreviewFixture();
  await receiver.change((state) => {
    state.queue = structuredClone(f.plans);
    state.automation = {
      id: 'a'.repeat(32),
      status: 'PAUSED',
      startedAt: '2026-10-15T00:00:00Z',
      startingDeliveryId: null,
      selection: { kind: 'commit', value: f.u2 },
      scanned: true,
      target: f.u2,
    };
  });
  const before = await receiver.read();
  const refs = await git(f.internal, ['show-ref']);
  provider.api = async () => assert.fail('the original frozen round must block new source reads');
  receiver.git.fetch = async () => assert.fail('the original frozen round must block new downloads');
  await assert.rejects(
    dispatch(
      receiver,
      {
        action: 'preview-sync',
        targetKind: 'commit',
        targetValue: f.u1,
      },
      { sourceProvider: provider },
    ),
    { code: 'RECOVERY_FIRST' },
  );
  assert.equal(receiver.active(before), undefined);
  assert.deepEqual(await receiver.read(), before);
  assert.equal(await git(f.internal, ['show-ref']), refs);
  assert.deepEqual(writes, []);
});
