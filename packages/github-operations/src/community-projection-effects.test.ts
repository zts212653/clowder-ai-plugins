import assert from 'node:assert/strict';
import test from 'node:test';
import { terminalFixture } from '../test/terminal-fixture.js';
import { CommunityProjector } from './business/domains/community/community-projector.js';
import type { CommunityEvent } from './business/model/index.js';

const pr = 'pr:example/project#13', issue = 'issue:example/project#99';
async function fixture() {
  const f = await terminalFixture();
  for (const event of [
    { sourceEventId: 'effects-issue', subjectKey: issue, kind: 'case.bootstrap', payload: { mappedState: 'in_progress' } },
    { sourceEventId: 'effects-pr', subjectKey: pr, kind: 'pr.opened', payload: { body: 'Fixes #99' } },
  ] as const) {
    const row: CommunityEvent = { ...event, classification: 'state-changing', at: 1 };
    await f.community.events.append(row); await f.projector.apply(row);
  }
  return f;
}
const merge: CommunityEvent = { sourceEventId: 'effects-merge', subjectKey: pr,
  kind: 'pr.merged', classification: 'state-changing', payload: {}, at: 2 };

test('concurrent reciprocal bootstrap and merge effects finish without waiting on each other', { timeout: 5000 }, async t => {
  const f = await terminalFixture(); t.after(() => f.community.stop());
  await f.community.events.append(merge); await f.projector.apply(merge);
  let entered!: () => void, release!: () => void;
  const linked = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  const producer = new CommunityProjector(f.community.events, f.community.objects, f.community.projectionOperations);
  const drain = (producer as unknown as { drainFollowUps(subject: string): Promise<void> }).drainFollowUps.bind(producer);
  Object.assign(producer, { drainFollowUps: async (subject: string) => {
    if (subject === pr) { entered(); await gate; }
    await drain(subject);
  } });
  const bootstrap: CommunityEvent = { sourceEventId: 'reciprocal-bootstrap', subjectKey: issue,
    kind: 'case.bootstrap', classification: 'state-changing', at: 3,
    payload: { mappedState: 'in_progress', originalRecord: { linkedPrNumbers: [13] } } };
  await f.community.events.append(bootstrap);
  const first = producer.apply(bootstrap);
  await linked;
  try { await f.projector.catchUp(pr); } finally { release(); }
  await first;
  assert.equal((await f.community.objects.get(issue))?.state, 'fixed');
  assert.equal((await f.community.objects.get(issue))?.pendingFollowUps, undefined);
  assert.equal((await f.community.objects.get(pr))?.pendingFollowUps, undefined);
});

test('a fresh projector resumes persisted effects after the former worker stopped before draining', async t => {
  const f = await fixture(); t.after(() => f.community.stop());
  const stopped = new CommunityProjector(f.community.events, f.community.objects, f.community.projectionOperations);
  Object.assign(stopped, { drainFollowUps: async () => { throw new Error('simulated stopped worker'); } });
  await f.community.events.append(merge);
  await assert.rejects(stopped.apply(merge), /stopped worker/);
  assert.equal((await f.community.objects.get(pr))?.pendingFollowUps?.length, 1);
  assert.equal((await f.community.objects.get(issue))?.state, 'in_progress');
  const resumed = new CommunityProjector(f.community.events, f.community.objects, f.community.projectionOperations);
  await resumed.catchUp(pr); await resumed.catchUp(pr);
  assert.equal((await f.community.objects.get(pr))?.pendingFollowUps, undefined);
  assert.equal((await f.community.objects.get(issue))?.state, 'fixed');
  assert.equal((await f.community.events.read(issue)).filter(event => event.kind === 'pr.merged').length, 1);
});

for (const fault of ['before-child-save', 'after-child-save', 'before-parent-ack'] as const) test(`persisted source retries ${fault} without a second cascade`, async t => {
  const f = await fixture(); t.after(() => f.community.stop());
  let failed = false;
  const broken = new CommunityProjector(f.community.events, {
    get: key => f.community.objects.get(key), delete: key => f.community.objects.delete(key),
    listSubjectKeys: () => f.community.objects.listSubjectKeys(),
    save: async projection => {
      const stop = !failed && (fault === 'before-parent-ack'
        ? projection.subjectKey === pr && projection.state === 'fixed' && !projection.pendingFollowUps
        : projection.subjectKey === issue && projection.state === 'fixed');
      if (stop) failed = true;
      if (stop && fault !== 'after-child-save') throw new Error(fault);
      await f.community.objects.save(projection);
      if (stop) throw new Error(fault);
    },
  }, f.community.projectionOperations);
  await f.community.events.append(merge); await assert.rejects(broken.apply(merge), new RegExp(fault));
  assert.equal((await f.community.objects.get(pr))?.pendingFollowUps?.length, 1);
  await f.projector.catchUp(pr);
  assert.equal((await f.community.objects.get(pr))?.pendingFollowUps, undefined);
  assert.equal((await f.community.objects.get(issue))?.state, 'fixed');
  assert.equal((await f.community.events.read(issue)).filter(event => event.kind === 'pr.merged').length, 1);
});
