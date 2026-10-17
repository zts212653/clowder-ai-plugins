import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryStorage } from '../test/memory-storage.js';
import { NativeIssueDraftRuntime, type NativeIssuePublisher } from './native-issue-drafts.js';

const input = { requestId: 'native-case', repo: 'Example/Project', title: 'Public issue', bodyMarkdown: 'Explicit public content' };
function fixture() {
  const storage = memoryStorage();
  let allowed = 'example/project';
  let calls = 0;
  const publisher: NativeIssuePublisher = { create: async () => { calls++; return { number: 7, url: 'https://github.com/Example/Project/issues/7' }; }, find: async () => null };
  const context = { storage, config: { get: async () => allowed } };
  return { storage, context, publisher, calls: () => calls, allowed: (value: string) => { allowed = value; } };
}

test('publication cannot precede durable journal, and two carriers cannot create twice', async () => {
  const f = fixture();
  const a = new NativeIssueDraftRuntime(f.context, f.publisher), b = new NativeIssueDraftRuntime(f.context, f.publisher);
  const { data: draft } = await a.create(input);
  const operation = { input: { draftId: draft.id } };
  const cas = f.storage.compareAndSet;
  f.storage.compareAndSet = async (key, revision, value) => {
    if ((value as { status?: string }).status === 'publishing') throw new Error('journal unavailable');
    return cas(key, revision, value);
  };
  await assert.rejects(a.publish(operation), /journal unavailable/);
  assert.equal(f.calls(), 0);
  f.storage.compareAndSet = cas;
  const settled = await Promise.allSettled([a.publish(operation), b.publish(operation)]);
  assert.ok(settled.some(result => result.status === 'fulfilled'));
  assert.equal(f.calls(), 1);
  assert.equal((await a.get({ draftId: draft.id })).data.status, 'published');
  await a.stop(); await b.stop();
});

test('allowlist is checked at publication; cancel/history and legacy isolation survive restart', async () => {
  const f = fixture();
  const a = new NativeIssueDraftRuntime(f.context, f.publisher);
  const { data: draft } = await a.create(input);
  await assert.rejects(a.create({ ...input, bodyMarkdown: 'Changed' }), /different content/);
  f.allowed('');
  await assert.rejects(a.publish({ input: { draftId: draft.id, userId: 'owner', confirmed: true } }), /allowlist/);
  assert.equal(f.calls(), 0);
  await a.cancel({ input: { draftId: draft.id } });
  await a.stop();
  const b = new NativeIssueDraftRuntime(f.context, f.publisher);
  assert.equal((await b.get({ draftId: draft.id })).data.status, 'cancelled');
  await assert.rejects(b.publish({ input: { draftId: draft.id } }), /cancelled/);
  const legacyId = 'a'.repeat(64);
  await f.storage.set(`community.drafts.${legacyId}`, { status: 'draft', userId: 'owner' });
  await assert.rejects(b.publish({ input: { draftId: legacyId } }), /legacy/);
  assert.ok(await f.storage.get(`community.drafts.${legacyId}`));
  assert.equal(f.calls(), 0);
  await b.stop();
});

test('unexpected publication identity stays uncertain rather than accepting another repository', async () => {
  const f = fixture();
  f.publisher.create = async () => ({ number: 1, url: 'https://github.com/other/repository/issues/1' });
  const a = new NativeIssueDraftRuntime(f.context, f.publisher);
  const { data: draft } = await a.create(input);
  assert.equal((await a.publish({ input: { draftId: draft.id } })).data.status, 'uncertain');
  assert.equal((await a.get({ draftId: draft.id })).data.status, 'publishing');
  await assert.rejects(a.cancel({ input: { draftId: draft.id } }), /reconcile/);
  await a.stop();
});
