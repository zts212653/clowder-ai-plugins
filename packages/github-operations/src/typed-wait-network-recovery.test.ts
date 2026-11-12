import assert from 'node:assert/strict';
import test from 'node:test';
import type { FeatureContext, PluginActionContext } from '@clowder-ai/plugin-sdk';
import { TypedWaitRuntime } from './typed-wait-runtime.js';
import { waitKey, type WaitRecordV1 } from './typed-wait-record.js';
import type { GitHubSnapshot, GitHubTrackingProvider } from './tracking-runtime.js';
import { memoryStorage } from '../test/memory-storage.js';

const eof = () => Object.assign(new Error('GitHub command failed'), {
  code: 1, stderr: 'Get "https://api.github.com/user": EOF\n',
});
function fixture() {
  let now = 1000, failure: Error | undefined, reads = 0, deliveryFailed = false;
  let snapshot: GitHubSnapshot = { state: 'open', headSha: 'a'.repeat(40), ci: 'pending', comments: [],
    reviews: [], commentsComplete: true, trackingIdentity: { selfLogin: 'owner', subjectAuthorLogin: 'owner' } };
  const storage = memoryStorage(), sent: unknown[] = [];
  const context = { storage, config: { get: async () => undefined }, secrets: { get: async () => undefined },
    threads: { get: async () => ({ id: 'home' }) }, messaging: { send: async (_thread: string, draft: unknown) => {
      if (deliveryFailed) throw new Error('temporary message unavailability');
      sent.push(draft); return { messageId: `notice-${sent.length}`, threadId: 'home' };
    } }, log() {} } as unknown as FeatureContext;
  const caller: PluginActionContext = { userId: 'owner', catId: 'codex61-sol', threadId: 'home',
    invocationId: 'turn', assertCurrent: async () => {} };
  const provider: GitHubTrackingProvider = { read: async () => {
    reads++; if (failure) throw failure; return structuredClone(snapshot);
  } };
  return { storage, caller, sent, runtime: () => new TypedWaitRuntime({ context, provider, coverage: async () => ({ covered: true }), now: () => now }),
    now: () => now, at: (value: number) => { now = value; }, reads: () => reads,
    fail: (value?: Error) => { failure = value; }, failDelivery: () => { deliveryFailed = true; }, change: () => { snapshot = { ...snapshot, headSha: 'b'.repeat(40),
      comments: [{ id: 2, author: 'contributor', body: 'Changed while offline', commentType: 'conversation' }] }; } };
}

for (const kind of ['pr', 'issue'] as const) test(`${kind}: prolonged EOF and a cold runtime recover the original offline change`, async () => {
  const f = fixture(); let runtime = f.runtime();
  try {
    const input = { registrationId: 'network-test', repoFullName: 'owner/repo', autoRenew: false };
    const task = kind === 'pr'
      ? await runtime.registerPr({ ...input, prNumber: 1, when: [{ kind: 'pr_head_changed' }] }, f.caller)
      : await runtime.registerIssue({ ...input, issueNumber: 1, when: [{ kind: 'issue_comment_added' }] }, f.caller);
    const original = structuredClone(task.automationState!.await!), registrationReads = f.reads();
    f.fail(eof());
    for (let n = 0; n < 8; n++) {
      f.at((await runtime.store.recovery.facts(task.id))!.nextPollAt + 1);
      await runtime.poll(kind);
      assert.deepEqual((await runtime.store.get(task.id))!.automationState!.await, original);
    }
    assert.equal(f.reads() - registrationReads, 8, 'a fifth transport failure must not retire automatic observation');
    await runtime.stop(); runtime = f.runtime(); f.fail(); f.change();
    f.at((await runtime.store.recovery.facts(task.id))!.nextPollAt + 1);
    await runtime.poll(kind);
    const current = (await runtime.store.get(task.id))!;
    assert.equal(current.automationState!.waitOutcome!.reason, 'matched');
    assert.equal(current.automationState!.waitOutcome!.generation, original.generation);
    assert.equal(current.automationState!.waitOutcome!.delivery, 'delivered');
    assert.equal(current.ownerCatId, task.ownerCatId); assert.equal(current.threadId, task.threadId);
    assert.equal((await runtime.store.recovery.facts(task.id))!.failures, 0);
  } finally { await runtime.stop(); }
});

test('network probes use persisted capped backoff and one status notice per outage', async () => {
  const f = fixture(); let runtime = f.runtime();
  try {
    const task = await runtime.registerPr({ registrationId: 'backoff', repoFullName: 'owner/repo', prNumber: 1 }, f.caller);
    f.fail(eof()); const delays: number[] = [];
    for (let n = 0; n < 10; n++) {
      f.at((await runtime.store.recovery.facts(task.id))!.nextPollAt + 1);
      const before = f.reads(); await runtime.poll('pr');
      assert.equal(f.reads(), before + 1);
      const next = (await runtime.store.recovery.facts(task.id))!.nextPollAt;
      delays.push(next - f.now());
      assert.ok(next > f.now() && next - f.now() <= 16 * 60_000);
      f.at(next - 1); await runtime.poll('pr');
      assert.equal(f.reads(), before + 1, 'ordinary ticks cannot bypass the retry deadline');
      if (n === 5) { await runtime.stop(); runtime = f.runtime(); }
    }
    assert.ok(delays[3]! > delays[0]!, 'a persistent outage must reduce request frequency');
    assert.equal(f.sent.length, 1, 'recovery probes cannot create a new notice on every revision');
  } finally { await runtime.stop(); }
});

test('the existing ready census cannot strand a legacy EOF pause with a null due score', async () => {
  const f = fixture(); let runtime = f.runtime();
  try {
    const task = await runtime.registerPr({ registrationId: 'old-pause', repoFullName: 'owner/repo', prNumber: 1,
      autoRenew: false, when: [{ kind: 'pr_head_changed' }] }, f.caller);
    const key = waitKey(task.id), entry = (await f.storage.get(key))!;
    const record = structuredClone(entry.value) as WaitRecordV1;
    const paused = { ...record, recovery: { ...record.recovery!, failures: 5, disposition: 'needs_attention' as const,
      reasonCode: 'github_observation_failed', lastError: { name: 'Error', message: 'GitHub command failed',
        code: 1, stderr: 'Get "https://api.github.com/user": EOF\n' } } };
    await f.storage.compareAndSetIndexed!(key, entry.revision, paused, { index: 'github-pr-waits', score: null });
    await f.storage.rebuildIndex!('github-pr-waits');
    await f.storage.set('github.typed-wait.recovery-census.v1', { v: 1, status: 'ready', cursor: '0' });
    await runtime.stop(); runtime = f.runtime();
    await runtime.store.recovery.initialize(); f.change();
    f.at((await runtime.store.recovery.facts(task.id))!.nextPollAt + 1); await runtime.poll('pr');
    assert.equal((await runtime.store.get(task.id))!.automationState!.waitOutcome?.reason, 'matched');
  } finally { await runtime.stop(); }
});

test('a review-thread GraphQL transport EOF also recovers without spending the subscription lifetime', async () => {
  const f = fixture(), runtime = f.runtime();
  try {
    const task = await runtime.registerPr({ registrationId: 'graphql-outage', repoFullName: 'owner/repo', prNumber: 1 }, f.caller);
    const before = f.reads();
    f.fail(Object.assign(new Error('GitHub command failed'), { code: 1, stderr: 'Post "https://api.github.com/graphql": EOF\n' }));
    for (let n = 0; n < 6; n++) {
      f.at((await runtime.store.recovery.facts(task.id))!.nextPollAt + 1); await runtime.poll('pr');
    }
    assert.equal(f.reads() - before, 6);
  } finally { await runtime.stop(); }
});

test('a real deadline still expires locally during network backoff', async () => {
  const f = fixture(), runtime = f.runtime();
  try {
    const task = await runtime.registerPr({ registrationId: 'expiry', repoFullName: 'owner/repo', prNumber: 1, expiresAt: 100_000 }, f.caller);
    f.fail(eof()); await runtime.poll('pr');
    f.at((await runtime.store.recovery.facts(task.id))!.nextPollAt + 1); await runtime.poll('pr');
    const before = f.reads(); f.at(100_000); await runtime.poll('pr');
    assert.equal(f.reads(), before);
    assert.equal((await runtime.store.get(task.id))!.automationState!.waitOutcome!.reason, 'expired');
  } finally { await runtime.stop(); }
});

test('a temporarily unavailable CI snapshot cannot permanently park its original wait', async () => {
  const f = fixture(), runtime = f.runtime();
  try {
    const task = await runtime.registerPr({ registrationId: 'ci-unavailable', repoFullName: 'owner/repo', prNumber: 1 }, f.caller);
    const before = f.reads(); f.fail(new Error('GitHub CI snapshot unavailable'));
    for (let n = 0; n < 6; n++) {
      f.at((await runtime.store.recovery.facts(task.id))!.nextPollAt + 1); await runtime.poll('pr');
    }
    assert.equal(f.reads() - before, 6);
  } finally { await runtime.stop(); }
});

test('cancelling a backed-off wait survives the recovery census and cannot restart observation', async () => {
  const f = fixture(); let runtime = f.runtime();
  try {
    const task = await runtime.registerPr({ registrationId: 'cancel', repoFullName: 'owner/repo', prNumber: 1 }, f.caller);
    f.fail(eof()); await runtime.poll('pr');
    await runtime.unregister({ subjectKey: task.subjectKey }, f.caller);
    const before = f.reads();
    await runtime.stop(); runtime = f.runtime();
    await runtime.store.recovery.initialize(true); f.at(f.now() + 24 * 60 * 60_000); await runtime.poll('pr');
    assert.equal(f.reads(), before);
    assert.equal((await runtime.store.get(task.id))!.automationState!.waitOutcome!.reason, 'user_cancel');
  } finally { await runtime.stop(); }
});

for (const detail of ['dial tcp: lookup api.github.com: no such host', 'dial tcp: lookup api.github.com: Temporary failure in name resolution',
  'dial tcp: lookup api.github.com: nodename nor servname provided, or not known', 'dial tcp: lookup api.github.com: server misbehaving',
  'dial tcp: connect: no route to host', 'dial tcp: connect: network is down', "dial tcp: connect: can't assign requested address",
  'dial tcp: connect: connection refused', 'write tcp: broken pipe', 'net/http: request canceled (Client.Timeout exceeded while awaiting headers)',
  'error connecting to api.github.com'])
  test(`gh exit 1 remains recoverable: ${detail}`, async () => {
    const f = fixture(), runtime = f.runtime();
    try {
      const task = await runtime.registerPr({ registrationId: 'go-network', repoFullName: 'owner/repo', prNumber: 1 }, f.caller);
      const before = f.reads(); f.fail(Object.assign(new Error('GitHub command failed'), { code: 1,
        stderr: detail.startsWith('error connecting') ? detail : `Get "https://api.github.com/user": ${detail}` }));
      for (let n = 0; n < 6; n++) { f.at((await runtime.store.recovery.facts(task.id))!.nextPollAt + 1); await runtime.poll('pr'); }
      assert.equal(f.reads() - before, 6);
    } finally { await runtime.stop(); }
  });

for (const stderr of ['gh: Bad credentials (HTTP 401)', 'gh: Resource not accessible by integration (HTTP 403)',
  'gh: Not Found (HTTP 404)', 'archive: unexpected EOF', 'local schema: no such host field exists',
  'Get "https://elsewhere.invalid/file": dial tcp: lookup elsewhere.invalid: no such host'])
  test(`non-transport failure retains attention: ${stderr}`, async () => {
    const f = fixture(), runtime = f.runtime();
    try {
      const task = await runtime.registerPr({ registrationId: 'hard-error', repoFullName: 'owner/repo', prNumber: 1 }, f.caller);
      const before = f.reads(); f.fail(Object.assign(new Error('GitHub command failed'), { code: 1, stderr }));
      for (let n = 0; n < 6; n++) { f.at((await runtime.store.recovery.facts(task.id))!.nextPollAt + 1); await runtime.poll('pr'); }
      assert.equal(f.reads() - before, 5); assert.equal((await runtime.store.recovery.facts(task.id))!.disposition, 'needs_attention');
    } finally { await runtime.stop(); }
  });

test('a hard failure clears the network reason before reaching attention', async () => {
  const f = fixture(), runtime = f.runtime();
  try {
    const task = await runtime.registerPr({ registrationId: 'transition', repoFullName: 'owner/repo', prNumber: 1 }, f.caller);
    f.fail(eof()); await runtime.poll('pr'); f.fail(new Error('HTTP 401: authentication required'));
    f.at((await runtime.store.recovery.facts(task.id))!.nextPollAt + 1); await runtime.poll('pr');
    const facts = (await runtime.store.recovery.facts(task.id))!;
    assert.equal(facts.retryable, false); assert.equal(facts.reasonCode, undefined);
  } finally { await runtime.stop(); }
});

test('entering attention cancels a pending network notice; explicit retry clears its error classification', async () => {
  const f = fixture(), runtime = f.runtime();
  try {
    const task = await runtime.registerPr({ registrationId: 'notice-transition', repoFullName: 'owner/repo', prNumber: 1 }, f.caller);
    f.fail(eof()); f.failDelivery();
    for (let n = 0; n < 5; n++) { f.at((await runtime.store.recovery.facts(task.id))!.nextPollAt + 1); await runtime.poll('pr'); }
    f.fail(new Error('HTTP 403: forbidden'));
    f.at((await runtime.store.recovery.facts(task.id))!.nextPollAt + 1); await runtime.poll('pr');
    const facts = (await runtime.store.recovery.facts(task.id))!;
    assert.equal(Object.values(facts.notices).filter(n => n.state === 'pending').length, 1);
    await runtime.retry({ taskId: task.id, expectedScope: facts.scope, expectedRecoveryRevision: facts.revision }, f.caller);
    assert.equal((await runtime.store.recovery.facts(task.id))!.retryable, undefined);
  } finally { await runtime.stop(); }
});
