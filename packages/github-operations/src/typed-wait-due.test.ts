import assert from 'node:assert/strict';
import test from 'node:test';
import type { FeatureContext, PluginActionContext } from '@clowder-ai/plugin-sdk';
import { TypedWaitRuntime } from './typed-wait-runtime.js';
import type { GitHubSnapshot } from './tracking-runtime.js';
import { memoryStorage } from '../test/memory-storage.js';
import { GitHubRateLimitError } from './business/infrastructure/github/request-budget.js';

function fixture() {
  let now = 1000, failure: Error | undefined, reads = 0;
  const storage = memoryStorage(), sent: unknown[] = [], logs: Array<{ message: string; fields?: unknown }> = [];
  const snapshot: GitHubSnapshot = { state: 'open', headSha: 'a'.repeat(40), ci: 'pending', comments: [], reviews: [], commentsComplete: true,
    trackingIdentity: { selfLogin: 'owner', subjectAuthorLogin: 'owner' } };
  const context = { storage, config: { get: async () => undefined }, secrets: { get: async () => undefined },
    threads: { get: async () => ({ id: 'home' }) }, messaging: { send: async (_thread: string, draft: unknown) => {
      sent.push(draft); return { messageId: 'notice', threadId: 'home' }; } }, log(_level: string, message: string, fields?: unknown) { logs.push({ message, fields }); } } as unknown as FeatureContext;
  const caller: PluginActionContext = { userId: 'owner', catId: 'codex61-sol', threadId: 'home', invocationId: 'turn', assertCurrent: async () => {} };
  const runtime = () => new TypedWaitRuntime({ context, now: () => now, coverage: async () => ({ covered: true }),
    provider: { read: async () => { reads++; if (failure) throw failure; return structuredClone(snapshot); } } });
  return { storage, context, caller, sent, logs, runtime, reads: () => reads, advance: () => { now += 60_001; },
    fail: (error?: Error) => { failure = error; } };
}
const input = { registrationId: 'original-registration', repoFullName: 'owner/repo', prNumber: 1 };

test('real failed observations leave automatic polling after five attempts and survive a cold runtime', async () => {
  const f = fixture(); let runtime = f.runtime();
  try {
    const tracked = await runtime.registerPr(input, f.caller), registrationReads = f.reads();
    f.fail(new Error('provider observation failed'));
    for (let n = 0; n < 8; n++) { f.advance(); await runtime.poll('pr'); }
    assert.equal(f.reads() - registrationReads, 5);
    assert.notEqual((await runtime.store.get(tracked.id))?.status, 'done');
    await runtime.stop(); runtime = f.runtime();
    f.advance(); await runtime.poll('pr');
    assert.equal(f.reads() - registrationReads, 5, 'recreation cannot reset the original failure budget');
    assert.equal(f.sent.length, 1, 'the original owner receives one idempotent attention notice');
    const notice = f.sent[0] as { wake?: unknown; meta: { phase: string }; idempotencyKey: string };
    assert.equal(notice.wake, undefined); assert.equal(notice.meta.phase, 'status');
    assert.match(notice.idempotencyKey, /^github-wait-recovery:/);
  } finally { await runtime.stop(); }
});

test('normal waiting and provider quota deferral never consume the failure budget', async () => {
  const f = fixture(), runtime = f.runtime();
  try {
    const tracked = await runtime.registerPr(input, f.caller), baselineReads = f.reads();
    for (let n = 0; n < 8; n++) { f.advance(); await runtime.poll('pr'); }
    assert.equal(f.reads() - baselineReads, 8);
    f.fail(new GitHubRateLimitError(10_000_000));
    for (let n = 0; n < 8; n++) { f.advance(); await runtime.poll('pr'); }
    f.fail(); f.advance();
    assert.notEqual((await runtime.store.get(tracked.id))?.status, 'done');
    const before = f.reads(); await runtime.poll('pr');
    assert.equal(f.reads(), before, 'a real quota reset defers the item until its recorded due time');
  } finally { await runtime.stop(); }
});

for (const missing of ['compareAndSetIndexed', 'readDue', 'rebuildIndex', 'scan'] as const)
test(`a Host missing ${missing} rejects registration before saving a claimed subscription`, async () => {
  const f = fixture();
  delete f.context.storage[missing];
  const runtime = f.runtime();
  try {
    await assert.rejects(runtime.registerPr(input, f.caller), /indexed.*storage.*unavailable/i);
    assert.equal(Object.keys(await f.storage.list()).filter(key => key.startsWith('github.typed-wait.v1.')).length, 0);
    assert.equal(f.reads(), 0);
  } finally { await runtime.stop(); }
});

test('a malformed canonical wait is parked without hiding a healthy due neighbor or changing its business bytes', async () => {
  const f = fixture(), runtime = f.runtime();
  try {
    const bad = await runtime.registerPr(input, f.caller);
    await runtime.registerPr({ ...input, registrationId: 'neighbor', prNumber: 2 }, f.caller);
    await runtime.store.recovery.initialize();
    const rows = await f.storage.list(), [name, entry] = Object.entries(rows).find(([, entry]) =>
      (entry.value as { task?: { id?: string } })?.task?.id === bad.id)!;
    const original = { ...(entry.value as object), task: { ...bad, kind: 'malformed' } };
    await f.storage.compareAndSetIndexed!(name, entry.revision, original, { index: 'github-pr-waits', score: 0 });
    const before = f.reads();
    await runtime.poll('pr');
    assert.equal(f.reads() - before, 1, 'the healthy neighbor must still be observed');
    const current = (await f.storage.get(name))!.value as { task: unknown; recovery: { disposition: string } };
    assert.deepEqual(current.task, original.task);
    assert.equal(current.recovery.disposition, 'needs_attention');
    assert.equal((await f.storage.readDue!({ index: 'github-pr-waits', before: 1000, limit: 20 })).status, 'ready');
    await runtime.store.recovery.initialize(true);
    assert.equal((await runtime.store.recovery.facts(bad.id))!.disposition, 'needs_attention');
  } finally { await runtime.stop(); }
});

test('a recorded quota reset cannot hide an earlier explicit wait deadline', async () => {
  const f = fixture(), runtime = f.runtime();
  try {
    const tracked = await runtime.registerPr({ ...input, expiresAt: 61000 }, f.caller);
    f.fail(new GitHubRateLimitError(10_000_000));
    await runtime.poll('pr');
    const before = f.reads();
    f.advance(); await runtime.poll('pr');
    assert.equal(f.reads(), before, 'expiry is decided locally without another provider read');
    assert.equal((await runtime.store.get(tracked.id))?.automationState?.waitOutcome?.reason, 'expired');
    assert.equal(f.sent.length, 1);
  } finally { await runtime.stop(); }
});

test('zero-due rounds use the native index and still emit one numeric summary', async () => {
  const f = fixture(), runtime = f.runtime();
  try {
    await runtime.store.recovery.initialize();
    f.context.storage.scan = async () => assert.fail('a ready round cannot scan retained history');
    f.context.storage.list = async () => assert.fail('a ready round cannot list retained history');
    await runtime.poll('pr');
    const summaries = f.logs.filter(log => log.message === 'GitHub wait recovery round');
    assert.equal(summaries.length, 1);
    assert.deepEqual(summaries[0]!.fields, { kind: 'pr', selected: 0, visited: 0, failed: 0, deferred: 0, elapsedMs: 0 });
    assert.equal(f.reads(), 0);
  } finally { await runtime.stop(); }
});

test('corrupt recovery counters retain their original bytes and cannot reset into automatic retries', async () => {
  const f = fixture(), runtime = f.runtime();
  try {
    const tracked = await runtime.registerPr(input, f.caller);
    await runtime.store.recovery.initialize();
    const [name, entry] = Object.entries(await f.storage.list()).find(([, row]) =>
      (row.value as { task?: { id?: string } })?.task?.id === tracked.id)!;
    const original = entry.value as { recovery: Record<string, unknown> };
    const invalid = { ...original.recovery, failures: 'corrupt-budget' };
    await f.storage.compareAndSetIndexed!(name, entry.revision, { ...original, recovery: invalid }, { index: 'github-pr-waits', score: 0 });
    const before = f.reads();
    await runtime.poll('pr');
    await runtime.store.recovery.initialize(true);
    f.advance(); await runtime.poll('pr');
    const current = (await f.storage.get(name))!.value as { recovery: { disposition: string }; malformedRecovery: unknown };
    assert.equal(current.recovery.disposition, 'needs_attention');
    assert.deepEqual(current.malformedRecovery, invalid);
    assert.equal(f.reads(), before);
  } finally { await runtime.stop(); }
});
