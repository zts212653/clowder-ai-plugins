import assert from 'node:assert/strict';
import test from 'node:test';
import { Receiver } from '../src/engine.mjs';
import { repositories } from './fixtures.mjs';
import { issuePlatform } from './issue-fixtures.mjs';

async function setup() {
  const f = await repositories(),
    platform = await issuePlatform(f);
  const receiver = new Receiver({
    ...f.config,
    internalWebUrl: 'https://codehub.example/core',
    issues: platform.config,
  });
  await receiver.adopt(f.u0, f.i0);
  await receiver.setQueue(f.plans);
  await receiver.start();
  return { f, platform, receiver };
}
test('automatic Issue lifecycle reuses one identity, verifies each PR link, and closes after all required commits merge', async () => {
  const { f, platform, receiver } = await setup();
  for (let number = 1; number <= 2; number++) {
    await receiver.prepare();
    assert.equal((await platform.read()).creates, 1);
    await receiver.linkPr(`https://codehub.example/core/pull/${number}`);
    let state = await receiver.status();
    assert.equal(state.active.issueLinks['issue-71'].url, state.active.prUrl);
    await f.merge(state.active);
    await receiver.recover();
    state = await receiver.status();
    assert.equal(state.deliveries.at(-1).status, 'COMPLETE');
    assert.equal(state.issues['issue-71'].state, number === 1 ? 'open' : 'closed');
    assert.equal(state.issues['issue-71'].receipts.at(-1).confirmedBy, 'platform');
    if (number === 1) await receiver.start();
  }
  assert.equal((await platform.read()).creates, 1);
  assert.equal((await platform.read()).updates, 1);
});
test('lost create receipt is recovered by lookup without creating another Issue', async () => {
  const { platform, receiver } = await setup();
  await platform.edit({ loseCreate: true });
  await assert.rejects(() => receiver.syncIssues(), { code: 'ISSUE_CREATE_RESULT_UNKNOWN' });
  assert.equal((await receiver.status()).active.candidate, null);
  await receiver.syncIssues();
  assert.equal((await platform.read()).creates, 1);
  assert.equal((await receiver.status()).issues['issue-71'].internalId, '318');
});
test('after code acceptance, failed Issue readback retains the original PR and metadata-only recovery', async () => {
  const { f, platform, receiver } = await setup();
  await receiver.prepare();
  await receiver.linkPr('https://codehub.example/core/pull/1');
  const original = (await receiver.status()).active;
  await f.merge(original);
  const saved = await platform.read();
  await platform.edit({ items: {} });
  await assert.rejects(() => receiver.recover(), { code: 'ISSUE_OBJECT_MISSING' });
  let state = await receiver.status();
  assert.equal(state.active.status, 'CODE_ACCEPTED_PENDING_METADATA');
  assert.equal(state.accepted.upstream, f.u1);
  await platform.edit({ items: saved.items });
  await receiver.syncIssues();
  state = await receiver.status();
  assert.equal(state.deliveries[0].candidate, original.candidate);
  assert.equal(state.deliveries[0].prUrl, original.prUrl);
  assert.equal((await platform.read()).creates, 1);
});

test('a stored creation intent with no object blocks recreation across a new Receiver', async () => {
  const { platform, receiver } = await setup();
  await platform.edit({ loseCreate: true });
  await assert.rejects(() => receiver.syncIssues(), { code: 'ISSUE_CREATE_RESULT_UNKNOWN' });
  await platform.edit({ items: {}, loseCreate: false });
  const restarted = new Receiver(receiver.config);
  await assert.rejects(() => restarted.syncIssues(), { code: 'ISSUE_CREATE_RESULT_UNKNOWN' });
  assert.equal((await platform.read()).creates, 1);
  assert.equal((await restarted.status()).active.candidate, null);
});

test('forged Issue identity stops association and preserves the same PR without closing another Issue', async () => {
  const { platform, receiver } = await setup();
  await receiver.prepare();
  const data = await platform.read();
  for (const item of Object.values(data.items)) item.sourceId = 'other-source';
  await platform.edit({ items: data.items });
  await assert.rejects(() => receiver.linkPr('https://codehub.example/core/pull/1'), {
    code: 'ISSUE_IDENTITY_CONFLICT',
  });
  const state = await receiver.status();
  assert.equal(state.active.prUrl, 'https://codehub.example/core/pull/1');
  assert.equal(state.issues['issue-71'].internalId, '318');
  assert.equal((await platform.read()).updates, 0);
});
