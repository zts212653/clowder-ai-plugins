import assert from 'node:assert/strict';
import test from 'node:test';
import { SdkCommunityEventLog } from './business/domains/community/CommunityEventLog.js';
import { memoryStorage } from '../test/memory-storage.js';
import { CommunityCollectionRuntime, SdkCommunityCollectionStore } from './community-collection.js';
import { registerRoutingTracking } from './business/domains/community/community-auto-tracking.js';
import type { GitHubSnapshot } from './tracking-runtime.js';
const route = { kind: 'case.routed', subjectKey: 'issue:org/repo#1', sourceEventId: 'route:1', classification: 'state-changing', at: 1,
  payload: { ownerThreadId: 'thread', catId: 'cat' } } as const;
const snapshot: GitHubSnapshot = { state: 'open', commentsComplete: true, comments: [{ id: 11, author: 'someone', body: 'hello', commentType: 'conversation' }], reviews: [] };
async function fixture() {
  const storage = memoryStorage(), store = new SdkCommunityCollectionStore(storage);
  await new SdkCommunityEventLog(storage).append(route);
  await registerRoutingTracking(route, store, { userId: 'owner', fetchCommentCursor: async () => 10 });
  let fail = false, called = 0; const cursors: unknown[] = [];
  const runtime = new CommunityCollectionRuntime({ store, allowed: async () => true,
    provider: { read: async (_target, _signal, cursor) => { cursors.push(cursor); return snapshot; } },
    collect: async () => { called++; if (fail) throw new Error('event write failed'); }, observe: async () => {} });
  return { storage, store, runtime, cursors, called: () => called, fail: (value: boolean) => { fail = value; } };
}
test('case.routed registration is private durable collection, with no native wait authority', async () => {
  const f = await fixture();
  await Promise.all([registerRoutingTracking(route, f.store), registerRoutingTracking(route, new SdkCommunityCollectionStore(f.storage))]);
  const items = await f.store.listByKind('issue_tracking'); assert.equal(items.length, 1);
  assert.match(items[0]!.id, /^community-collection:/); assert.equal(items[0]!.pluginWait, undefined);
  assert.equal(items[0]!.automationState?.await, undefined);
  await f.runtime.poll('issue'); assert.deepEqual(f.cursors, [{ inline: 0, conversation: 10 }]);
  assert.equal((await new SdkCommunityCollectionStore(f.storage).getBySubject(route.subjectKey))?.automationState?.issue?.lastCommentCursor, 11);
  await f.runtime.stop();
});
test('failed durable collection does not advance cursor and retries after runtime restart', async () => {
  const f = await fixture(); f.fail(true); await assert.rejects(f.runtime.poll('issue'), /event write/);
  assert.equal((await f.store.getBySubject(route.subjectKey))?.automationState?.issue?.lastCommentCursor, 10);
  await f.runtime.stop();
  let restored = 0;
  const restarted = new CommunityCollectionRuntime({ store: new SdkCommunityCollectionStore(f.storage), allowed: async () => true,
    provider: { read: async (_target, _signal, cursor) => { assert.equal(cursor?.conversation, 10); return snapshot; } },
    collect: async () => { restored++; }, observe: async () => {} });
  await restarted.poll('issue'); assert.equal(restored, 1);
  assert.equal((await f.store.getBySubject(route.subjectKey))?.automationState?.issue?.lastCommentCursor, 11);
  await restarted.stop();
});
test('cancel while provider is reading suppresses projection and retains a durable retired record', async () => {
  const f = await fixture(); let collected = false;
  const runtime = new CommunityCollectionRuntime({ store: f.store, allowed: async () => true,
    provider: { read: async () => { await f.store.delete((await f.store.getBySubject(route.subjectKey))!.id); return snapshot; } },
    collect: async () => { collected = true; }, observe: async () => {} });
  await runtime.poll('issue'); assert.equal(collected, false); assert.equal(await f.store.getBySubject(route.subjectKey), null);
  assert.equal(Object.keys(await f.storage.list()).filter(key => key.startsWith('community.collection.v1.')).length, 1, 'cancel never erases history');
  assert.equal((await f.store.listByKind('issue_tracking'))[0]?.status, 'done');
  await runtime.stop(); await f.runtime.stop();
});
test('unconfigured repo and incomplete provider snapshot do not collect or retire work', async () => {
  for (const allowed of [false, true]) {
    const f = await fixture(); let collected = false;
    const runtime = new CommunityCollectionRuntime({ store: f.store, allowed: async () => allowed,
      provider: { read: async () => ({ ...snapshot, commentsComplete: false, state: 'closed' }) },
      collect: async () => { collected = true; }, observe: async () => {} });
    if (allowed) await assert.rejects(runtime.poll('issue'), /incomplete/); else await runtime.poll('issue');
    assert.equal(collected, false); assert.equal((await f.store.getBySubject(route.subjectKey))?.status, 'doing');
    await runtime.stop(); await f.runtime.stop();
  }
});

test('same-kind overlapping ticks join one read and stop fences late provider results', async () => {
  const f = await fixture(); let reads = 0, collected = 0;
  let entered!: () => void, release!: () => void;
  const start = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
  const runtime = new CommunityCollectionRuntime({ store: f.store, allowed: async () => true,
    provider: { read: async () => { reads++; entered(); await blocked; return snapshot; } },
    collect: async () => { collected++; }, observe: async () => {} });
  const a = runtime.poll('issue'), b = runtime.poll('issue'); assert.equal(a, b);
  const rejected = assert.rejects(a); await start;
  const stopped = runtime.stop(); release(); await Promise.all([rejected, stopped]);
  assert.equal(reads, 1); assert.equal(collected, 0);
  assert.equal((await f.store.getBySubject(route.subjectKey))?.automationState?.issue?.lastCommentCursor, 10);
  await f.runtime.stop();
});

test('rerouting during provider IO invalidates old collection and preserves cursors for the new owner', async () => {
  const f = await fixture(); let collected = false;
  const runtime = new CommunityCollectionRuntime({ store: f.store, allowed: async () => true,
    provider: { read: async () => {
      const reroute = { ...route, sourceEventId: 'route:2', payload: { ownerThreadId: 'new-thread', catId: 'new-cat' } };
      await new SdkCommunityEventLog(f.storage).append(reroute);
      await registerRoutingTracking(reroute, f.store);
      return snapshot;
    } }, collect: async () => { collected = true; }, observe: async () => {} });
  await runtime.poll('issue'); assert.equal(collected, false);
  const current = await f.store.getBySubject(route.subjectKey);
  assert.equal(current?.ownerCatId, 'new-cat'); assert.equal(current?.automationState?.issue?.lastCommentCursor, 10);
  await runtime.stop(); await f.runtime.stop();
});

test('stop during post-provider policy reread cannot enter collection', async () => {
  const f = await fixture(); let policyReads = 0, collected = false;
  const runtime = new CommunityCollectionRuntime({ store: f.store, allowed: async () => {
    if (++policyReads === 2) void runtime.stop(); return true;
  }, provider: { read: async () => snapshot }, collect: async () => { collected = true; }, observe: async () => {} });
  await assert.rejects(runtime.poll('issue'));
  assert.equal(collected, false);
  await f.runtime.stop();
});
