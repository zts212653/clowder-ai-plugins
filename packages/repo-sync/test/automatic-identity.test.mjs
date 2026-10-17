import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildCandidate } from '../src/commit-policy.mjs';
import { createConnection } from '../src/connections.mjs';
import { Receiver } from '../src/engine.mjs';
import { groupLandings } from '../src/github-landings.mjs';
import { git } from '../src/process.mjs';
import { repositories } from './fixtures.mjs';

test('direct main commits are included automatically, missing associations still fail', () => {
  const sha = 'a'.repeat(40);
  assert.equal(groupLandings([sha], { [sha]: [] }, 'main')[0].kind, 'commit');
  assert.throws(() => groupLandings([sha], {}, 'main'), { code: 'METADATA_INCOMPLETE' });
});

test('rewrite: unified authors, persistent SHA mappings, merge acceptance and future Issue targets', async () => {
  const f = await repositories();
  const config = {
    ...f.config,
    commitStrategy: 'rewrite',
    receivingIdentity: { name: 'Internal Sync', email: 'sync@example.invalid' },
  };
  let receiver = new Receiver(config);
  await receiver.adopt(f.u0, f.i0);
  await receiver.setQueue(f.plans);
  for (let index = 0; index < 2; index++) {
    await receiver.start();
    await receiver.linkIssue('issue-71', '318', 'https://codehub.example/core/issues/318');
    await receiver.prepare();
    const d = (await receiver.status()).active;
    assert.equal(d.commitMappings.length, 1);
    assert.equal(d.commitMappings[0].source, index ? f.u2 : f.u1);
    assert.equal(d.commitMappings[0].internal, d.candidate);
    assert.notEqual(d.candidate, d.target);
    assert.equal(
      await git(receiver.git.directory, ['show', '-s', '--format=%an|%ae|%cn|%ce', d.candidate]),
      'Internal Sync|sync@example.invalid|Internal Sync|sync@example.invalid',
    );
    assert.equal(await git(receiver.git.directory, ['rev-list', '--count', `${d.base.internal}..${d.candidate}`]), '1');
    await receiver.linkPr(`https://codehub.example/core/pull/${index + 1}`);
    await f.merge(d);
    receiver = new Receiver(config);
    await receiver.recover();
    await receiver.receipts([{ sourceId: 'issue-71', internalId: '318', state: index ? 'closed' : 'open' }]);
    assert.equal((await receiver.status()).active, undefined);
  }
  const folder = await mkdtemp(join(tmpdir(), 'repo-sync-identity-')),
    file = join(folder, 'config.json');
  await writeFile(file, JSON.stringify(config));
  const connection = await createConnection(file);
  await connection.run({
    action: 'configure-identity',
    expectedRevision: connection.describe().revision,
    commitStrategy: 'preserve',
    receivingIdentity: { name: 'Next Sync', email: 'next@example.invalid' },
  });
  assert.equal((await connection.current()).config.bindingId, receiver.config.bindingId);
  assert.equal((await connection.current()).config.commitStrategy, 'preserve');
  assert.deepEqual((await (await connection.current()).status()).accepted, (await receiver.status()).accepted);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).receivingIdentity.name, 'Next Sync');
});

test('preserve: only one receiving node in addition to source history', async () => {
  const f = await repositories(),
    receiver = new Receiver(f.config);
  await receiver.adopt(f.u0, f.i0);
  await receiver.setQueue(f.plans);
  await receiver.start();
  await receiver.linkIssue('issue-71', '318', 'https://codehub.example/core/issues/318');
  await receiver.prepare();
  const d = (await receiver.status()).active;
  assert.equal(await git(receiver.git.directory, ['rev-list', '--count', d.candidate, `^${f.i0}`, `^${f.u1}`]), '1');
});

test('rewrite preserves merge topology, exact message bytes, internal files and deterministic retry', async () => {
  const f = await repositories();
  await writeFile(join(f.review, 'README.md'), 'internal documentation');
  await git(f.review, ['add', '.']);
  await git(f.review, ['commit', '-m', 'internal documentation']);
  await git(f.review, ['push', 'origin', 'main']);
  f.i0 = await git(f.review, ['rev-parse', 'HEAD']);
  await git(f.source, ['switch', '-c', 'feature', f.u0]);
  await writeFile(join(f.source, 'README.md'), 'source documentation');
  await git(f.source, ['add', '.']);
  await git(f.source, ['commit', '--cleanup=verbatim', '-F', '-'], {
    input: 'message with trailing spaces  \n\nbody\n\n\n',
  });
  await git(f.source, ['switch', 'main']);
  await git(f.source, ['merge', '--no-ff', 'feature', '-m', 'source merge']);
  const target = await git(f.source, ['rev-parse', 'HEAD']);
  const config = {
    ...f.config,
    internalPaths: ['README.md'],
    commitStrategy: 'rewrite',
    receivingIdentity: { name: 'Internal Sync', email: 'sync@example.invalid' },
  };
  const receiver = new Receiver(config);
  await receiver.adopt(f.u0, f.i0);
  await receiver.setQueue([{ ...f.plans[0], target, issues: [] }]);
  await receiver.start();
  await receiver.prepare();
  const state = await receiver.status(),
    d = state.active;
  assert.equal(d.commitMappings.length, 4);
  assert.equal((await git(receiver.git.directory, ['show', '-s', '--format=%P', d.candidate])).split(' ').length, 2);
  assert.equal(await git(receiver.git.directory, ['show', `${d.candidate}:README.md`]), 'internal documentation');
  for (const { source, internal } of d.commitMappings) {
    const message = async (sha) => {
      const buffer = await git(receiver.git.directory, ['cat-file', 'commit', sha], { binary: true });
      return buffer.subarray(buffer.indexOf(Buffer.from('\n\n')) + 2);
    };
    assert.deepEqual(await message(source), await message(internal));
  }
  assert.equal((await buildCandidate(receiver, state, d)).head, d.candidate);
  const changed = new Receiver({ ...config, receivingIdentity: { name: 'Other', email: 'other@example.invalid' } });
  await assert.rejects(() => changed.prepare(), { code: 'COMMIT_POLICY_CHANGED' });
  assert.equal((await receiver.status()).active.candidate, d.candidate);
});
