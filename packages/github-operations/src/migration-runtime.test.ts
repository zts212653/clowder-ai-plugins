import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { parse } from 'yaml';
import type { ModulePluginHostShape, PluginTaskReadItem, PluginActionContext, PluginHostActionContext } from '@clowder-ai/plugin-sdk';
import { createGitHubPluginModule } from './plugin-entrypoint.js';
import { IsolatedStorage } from '../test/migration-host-storage.js';
import type { TaskItem, GitHubIssueAwaitStateV1 } from './business/model/index.js';
import type { MigrationSource } from './migration-source.js';
import { sourceDigest, freezeGitHubSource, migrationKey } from './migration-source.js';
import { SdkCommunityEventLog } from './business/domains/community/CommunityEventLog.js';

const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8'));
const signal = new AbortController().signal;
export function migrationFixture() {
  const storage = new IsolatedStorage();
  const tasks = new Map<string, PluginTaskReadItem>();
  const sent: unknown[] = [];
  const logs: string[] = [];
  const forbidden = async (): Promise<never> => { throw new Error('No timeline read or unrelated Host mutation expected'); };
  let reads = 0;
  const host: ModulePluginHostShape = {
    pluginInstanceId: 'instance', dataPath: '/unused/isolated-migration', storage,
    config: { get: async key => key === 'recoveryMode' ? 'import-only' : undefined },
    secrets: { get: async () => undefined }, members: { get: forbidden, list: forbidden },
    streams: { read: async function* () { throw new Error('No stream read expected'); } },
    threads: { get: async id => ({ id, title: null, createdAt: 1, lastActiveAt: 1, preferredCats: [], featureRefs: [], deepLinkUrl: 'https://host/thread' }),
      getCats: async () => ({ participants: [], routableNow: [{ catId: 'cat', displayName: 'Cat', aliases: [] }], routableNotJoined: [], notRoutable: [] }),
      list: async () => ['thread', 'original-inbox', 'new-owner-selected-thread'].map(id => ({ id, title: null, createdAt: 1, lastActiveAt: 1, preferredCats: [], featureRefs: [], deepLinkUrl: 'https://host/thread' })),
      readMessages: forbidden, addParticipants: forbidden, create: forbidden, update: forbidden },
    tasks: { get: async q => structuredClone(q.id ? tasks.get(q.id) ?? null : [...tasks.values()].find(t => t.subjectKey === q.subjectKey) ?? null),
      list: async filter => [...tasks.values()].filter(t => !filter.kind || t.kind === filter.kind),
      create: forbidden, update: async (id, patch, conditions) => {
        const old = tasks.get(id);
        if (!old || !patch.wait || conditions?.expectedThreadId !== old.threadId
          || (old.pluginWait?.generation ?? null) !== patch.wait.expectedGeneration) return null;
        const w = patch.wait;
        const next = { ...old, status: w.active ? 'doing' as const : old.status, updatedAt: old.updatedAt + 1, pluginWait: { pluginInstanceId: 'instance', generation: w.generation,
          ...(w.active ? { await: { generation: w.generation, ...w.active } } : {}),
          ...(w.outcome ? { waitOutcome: w.outcome } : {}) } };
        tasks.set(id, next); return structuredClone(next);
      } },
    messaging: { send: async value => { sent.push(value); return { threadId: value.threadId, messageId: 'message' }; } } as ModulePluginHostShape['messaging'],
    log: (_level, message) => { logs.push(message); },
  };
  const module = createGitHubPluginModule({ now: () => 1000, createProvider: () => ({ selfLogin: () => 'self',
    read: async target => { reads++; return { state: 'open', headSha: 'new', ci: 'pass', comments: target.kind === 'issue'
      ? [{ id: 24, author: 'external', body: 'New external update', commentType: 'conversation', createdAt: '2026-10-21T00:00:00Z' }] : [], reviews: [], commentsComplete: true }; } }) });
  const owner = (read = false): PluginHostActionContext => ({ kind: 'owner-http-request', userId: 'owner', pluginInstanceId: 'instance',
    operation: read ? 'read' : 'write', signal, assertCurrent: async () => {} });
  const caller: PluginActionContext = { catId: 'cat', threadId: 'thread', userId: 'owner', invocationId: 'new-invocation',
    ownerAuthProvenance: 'strict', source: { kind: 'primary', sourceMessageId: 'new-authenticated-source' }, assertCurrent: async () => {} };
  return { host, tasks, storage, sent, logs, module, owner, caller, reads: () => reads };
}

test('ordinary module activation in import-only mode holds every collector and exposes owner migration status', async t => {
  const f = migrationFixture(), active = await f.module.create(manifest).start(f.host);
  t.after(() => active.stop({ reason: 'test' }));
  assert.equal(typeof active.actions['github.migration.status'], 'function', 'ordinary owner migration entry is missing');
  for (const method of ['github.pr-tracking', 'github.issue-tracking', 'github.repo-scan', 'github.repo-comment-poll', 'github.community-reconciler']) {
    await assert.rejects(async () => active.actions[method]!({}), /import.*hold/i);
  }
  assert.equal(f.reads(), 0); assert.equal(f.sent.length, 0);
});

function frozenSource(): MigrationSource {
  const task: TaskItem = { id: 'old-pr', kind: 'pr_tracking', userId: 'owner', ownerCatId: 'cat', threadId: 'thread',
    subjectKey: 'pr:example/project#12', status: 'doing', title: 'Fixture', why: 'Fixture', createdBy: 'historical', createdAt: 1, updatedAt: 2,
    automationState: { review: { lastConversationCommentCursor: 23 }, await: { v: 1, generation: 27, subjectRef: 'pr:example/project#12',
      ownerFence: { kind: 'containing_task', generation: 27 }, baseline: { capturedAt: 1, headSha: 'old' },
      continuation: { when: [{ kind: 'pr_head_changed' }], then: 'Continue original work' }, createdAt: 1, autoRenew: false } } };
  const expired: TaskItem = { ...structuredClone(task), id: 'expired', kind: 'issue_tracking', subjectKey: 'issue:example/project#936',
    ownerCatId: 'codex', automationState: { await: { v: 1, generation: 1, subjectRef: 'issue:example/project#936',
      ownerFence: { kind: 'containing_task', generation: 1 }, baseline: { capturedAt: 1, issue: { lastCommentCursor: 2, state: 'open' } },
      continuation: { when: [{ kind: 'issue_comment_added' }], then: 'Old expired wait' }, createdAt: 1, expiresAt: 10 } } };
  const legacy: TaskItem = { ...structuredClone(task), id: 'old-issue', kind: 'issue_tracking', subjectKey: 'issue:example/project#42',
    automationState: { issue: { lastCommentCursor: 23, lastDeliveredCursor: 23, issueState: 'open' } } };
  return { v: 1, id: 'frozen-cut', userId: 'owner', sourceRef: 'isolated:read-only-source', capturedAt: 900,
    oldWriter: 'absent', coverage: { tracking: 'complete', repositories: 'complete', progress: 'complete', 'pending-receipts': 'complete', 'authority-retention': 'complete' },
    tasks: [task, legacy, expired], repositories: [], receipts: [], retainedAuthorityRefs: ['isolated:immutable-old-registration-authority'], unresolvedRepositoryDeliveries: 0 };
}
type Active = Awaited<ReturnType<ReturnType<ReturnType<typeof createGitHubPluginModule>['create']>['start']>>;
async function ownerCall(f: ReturnType<typeof migrationFixture>, active: Active, op: string, body: unknown = {}) {
  const read = op === 'status' || op === 'source';
  const result = await active.actions[`github.migration.${op}`]!({ request: { method: read ? 'GET' : 'POST',
    path: `github/migration/${op}`, principal: { kind: 'owner', id: 'owner' }, body } }, undefined, f.owner(read));
  return result as { body: { data: { phase: string; planDigest: string }; needsOriginalOwnerBindings?: string[] } };
}
function seed(f: ReturnType<typeof migrationFixture>, source: MigrationSource) {
  for (const task of source.tasks) f.tasks.set(task.id, structuredClone(task) as PluginTaskReadItem);
}

test('real owner stage/commit and original native bind preserve g27, retire expired history and continue a legacy issue', async t => {
  const f = migrationFixture(), source = frozenSource(); seed(f, source);
  let active = await f.module.create(manifest).start(f.host);
  t.after(() => active.stop({ reason: 'test' }));
  const stage = await ownerCall(f, active, 'stage', { snapshot: source, expectedDigest: sourceDigest(source) });
  const digest = stage.body.data.planDigest;
  assert.equal(stage.body.data.phase, 'staged'); assert.equal(f.reads(), 0); assert.equal(f.sent.length, 0);
  const commit = await ownerCall(f, active, 'commit', { expectedDigest: digest });
  assert.equal(commit.body.data.phase, 'committing'); assert.deepEqual(commit.body.needsOriginalOwnerBindings, ['old-pr']);
  await assert.rejects(ownerCall(f, active, 'release', { expectedDigest: digest }), /committed/);
  await assert.rejects(async () => active.actions['github.migration.bind-wait']!({ taskId: 'old-pr', expectedDigest: digest }, { ...f.caller, catId: 'other' }), /owner\/thread/);
  await active.actions['github.migration.bind-wait']!({ taskId: 'old-pr', expectedDigest: digest }, f.caller);
  assert.equal(f.tasks.get('old-pr')?.pluginWait?.generation, 27);
  assert.equal(f.tasks.get('expired')?.pluginWait, undefined, 'past g1 is never rearmed');
  await active.stop({ reason: 'restart during hold' }); active = await f.module.create(manifest).start(f.host);
  assert.equal(f.sent.length, 0); assert.equal(f.reads(), 0);
  assert.equal((await ownerCall(f, active, 'recover', { expectedDigest: digest })).body.data.phase, 'committed');
  await ownerCall(f, active, 'release', { expectedDigest: digest });
  await active.actions['github.pr-tracking']!({}); await active.actions['github.issue-tracking']!({});
  await active.actions['github.pr-tracking']!({}); await active.actions['github.issue-tracking']!({});
  assert.equal(f.sent.length, 2, 'one new PR fact and one new legacy comment, neither replayed');
  assert.equal(f.tasks.get('old-pr')?.pluginWait?.await, undefined, 'the original Host wait must terminate with the imported private wait');
  assert.equal(f.tasks.get('old-pr')?.pluginWait?.waitOutcome?.delivery, 'delivered');
  const listed = await active.actions['github.tracking.list']!({}) as { data: { tracking: TaskItem[] } };
  assert.equal(listed.data.tracking.find(task => task.id === 'old-issue')?.automationState?.issue?.lastDeliveredCursor, 24);
  assert.ok(!listed.data.tracking.some(task => task.id === 'expired'));
  assert.equal(f.tasks.get('old-issue')?.pluginWait, undefined, 'continuous old issue does not acquire a fabricated wait generation');
  const records = Object.values(await f.storage.list()).map(r => r.value).filter(v => !!v && typeof v === 'object');
  const history = records.find(v => 'task' in v && (v.task as TaskItem)?.id === 'expired' && 'sourceUpdatedAt' in v) as { task: TaskItem };
  assert.equal(history.task.ownerCatId, 'codex'); assert.equal(history.task.automationState?.await?.expiresAt, 10);
});

test('an imported wait stops before observation when its original Host owner or binding changes after release', async t => {
  for (const drift of ['owner', 'binding'] as const) {
    const f = migrationFixture(), source = frozenSource(); seed(f, source);
    const active = await f.module.create(manifest).start(f.host);
    t.after(() => active.stop({ reason: 'test' }));
    const staged = await ownerCall(f, active, 'stage', { snapshot: source, expectedDigest: sourceDigest(source) });
    const expectedDigest = staged.body.data.planDigest;
    await ownerCall(f, active, 'commit', { expectedDigest });
    await active.actions['github.migration.bind-wait']!({ taskId: 'old-pr', expectedDigest }, f.caller);
    await ownerCall(f, active, 'recover', { expectedDigest });
    await ownerCall(f, active, 'release', { expectedDigest });
    const host = f.tasks.get('old-pr')!;
    f.tasks.set(host.id, drift === 'owner' ? { ...host, ownerCatId: 'new-owner' } : { ...host, pluginWait: undefined });
    await active.actions['github.pr-tracking']!({});
    assert.equal(f.reads(), 0, `original ${drift} drift must stop provider observation`);
    assert.equal(f.sent.length, 0, `original ${drift} drift must not wake the old destination`);
  }
});

test('fresh private subscriptions coexist with a retained Host wait without acquiring Host Tasks', async t => {
  const f = migrationFixture(), source = { ...frozenSource(), tasks: frozenSource().tasks.slice(0, 1) };
  seed(f, source);
  let hostReads = 0, freshHead = 'a'.repeat(40);
  const get = f.host.tasks.get;
  f.host.tasks.get = async query => { assert.equal(query.id, 'old-pr'); hostReads++; return get(query); };
  const module = createGitHubPluginModule({ now: () => 1000, createProvider: () => ({ selfLogin: () => 'self',
    read: async target => ({ state: 'open', headSha: target.number === 12 ? 'b'.repeat(40) : freshHead,
      ci: 'pass', comments: [], reviews: [], commentsComplete: true }) }) });
  const active = await module.create(manifest).start(f.host); t.after(() => active.stop({ reason: 'test' }));
  const stage = await ownerCall(f, active, 'stage', { snapshot: source, expectedDigest: sourceDigest(source) });
  const expectedDigest = stage.body.data.planDigest;
  await ownerCall(f, active, 'commit', { expectedDigest });
  await active.actions['github.migration.bind-wait']!({ taskId: 'old-pr', expectedDigest }, f.caller);
  await ownerCall(f, active, 'recover', { expectedDigest });
  await ownerCall(f, active, 'release', { expectedDigest });
  const beforeRegistration = hostReads;
  const fresh = await active.actions['github.typed-wait.register-pr']!({ registrationId: 'new-private-intent',
    repoFullName: 'example/project', prNumber: 13, when: [{ kind: 'pr_head_changed' }], autoRenew: false }, f.caller) as TaskItem;
  assert.equal(hostReads, beforeRegistration, 'new registration must not consult Host Tasks');
  assert.equal(f.tasks.has(fresh.id), false); assert.equal(fresh.automationState?.await?.generation, 1);
  assert.equal(f.tasks.get('old-pr')?.pluginWait?.generation, 27);
  freshHead = 'c'.repeat(40);
  await active.actions['github.pr-tracking']!({}); await active.actions['github.pr-tracking']!({});
  assert.equal(f.sent.length, 2, 'each established registration delivers its new fact exactly once');
  assert.equal(f.tasks.size, 1); assert.equal(f.tasks.get('old-pr')?.pluginWait?.waitOutcome?.delivery, 'delivered');
});

test('recover keeps a Host task closed during import inert without rebinding or discarding its frozen history', async t => {
  const f = migrationFixture(), source = { ...frozenSource(), tasks: frozenSource().tasks.slice(0, 1) };
  seed(f, source);
  let active = await f.module.create(manifest).start(f.host);
  t.after(() => active.stop({ reason: 'test' }));
  const staged = await ownerCall(f, active, 'stage', { snapshot: source, expectedDigest: sourceDigest(source) });
  const expectedDigest = staged.body.data.planDigest;
  await ownerCall(f, active, 'commit', { expectedDigest });
  const original = f.tasks.get('old-pr')!;
  const closed = { ...original, status: 'done' as const, updatedAt: original.updatedAt + 10 };
  f.tasks.set(closed.id, closed);
  const hostSnapshot = structuredClone([...f.tasks]);
  assert.equal((await ownerCall(f, active, 'recover', { expectedDigest })).body.data.phase, 'committed');
  await active.stop({ reason: 'restart after forward settlement' });
  active = await f.module.create(manifest).start(f.host);
  await ownerCall(f, active, 'release', { expectedDigest });
  await active.actions['github.pr-tracking']!({});
  assert.equal(f.reads(), 0); assert.equal(f.sent.length, 0);
  assert.deepEqual([...f.tasks], hostSnapshot, 'settlement never writes or reopens the canonical Host Task');
  const rows = await f.storage.list();
  const history = Object.entries(rows).filter(([key]) => key.startsWith('github.migration.history.'));
  assert.equal(history.length, 1);
  assert.deepEqual((history[0]![1].value as { task: TaskItem }).task, source.tasks[0], 'original generation, baseline and outcome stay intact');
  assert.equal(Object.keys(rows).filter(key => key.startsWith('github.typed-wait.v1.')).length, 0, 'closed copies cannot enter provider collection');
  const journal = rows['github.migration.control.v1']!.value as { planDigest: string };
  assert.equal(journal.planDigest, expectedDigest, 'the original frozen plan identity is preserved');
});

test('terminal recovery rejects active drift, changed identity, existing first-binding intents and pending outcomes', async t => {
  for (const drift of ['active', 'owner', 'thread', 'subject', 'user', 'version', 'projection', 'intent', 'pending'] as const) {
    const f = migrationFixture();
    let source: MigrationSource = { ...frozenSource(), tasks: frozenSource().tasks.slice(0, 1) };
    if (drift === 'pending') {
      const task = source.tasks[0]!;
      source = { ...source, tasks: [{ ...task, automationState: { ...task.automationState, waitOutcome: { v: 1, generation: 26, subjectRef: 'pr:example/project#12',
        ownerFence: { kind: 'containing_task', generation: 26 }, outcomeId: 'pending-original', at: 800,
        reason: 'matched', delivery: 'pending' } } }],
        receipts: [{ taskId: 'old-pr', outcomeId: 'pending-original', sourceRef: 'original:no-send',
        disposition: 'not-delivered', messageAppended: false, wakeAccepted: false }] };
    }
    seed(f, source);
    const active = await f.module.create(manifest).start(f.host); t.after(() => active.stop({ reason: 'test' }));
    const staged = await ownerCall(f, active, 'stage', { snapshot: source, expectedDigest: sourceDigest(source) });
    const expectedDigest = staged.body.data.planDigest;
    await ownerCall(f, active, 'commit', { expectedDigest });
    const original = f.tasks.get('old-pr')!;
    const closed = { ...original, status: 'done' as const, updatedAt: original.updatedAt + 10 };
    if (drift === 'active') f.tasks.set('old-pr', { ...closed, status: 'doing' });
    else if (drift === 'owner') f.tasks.set('old-pr', { ...closed, ownerCatId: 'other' });
    else if (drift === 'thread') f.tasks.set('old-pr', { ...closed, threadId: 'other' });
    else if (drift === 'subject') f.tasks.set('old-pr', { ...closed, subjectKey: 'pr:example/project#99' });
    else if (drift === 'user') f.tasks.set('old-pr', { ...closed, userId: 'other' });
    else if (drift === 'version') f.tasks.set('old-pr', { ...closed, updatedAt: original.updatedAt });
    else if (drift === 'projection') f.tasks.set('old-pr', { ...closed, pluginWait: { pluginInstanceId: 'other', generation: 27 } });
    else {
      f.tasks.set('old-pr', closed);
      if (drift === 'intent') await f.storage.set(`github.migration.binding.${expectedDigest}.${migrationKey('old-pr')}`, { state: 'intent' });
    }
    const before = await f.storage.list();
    if (drift === 'intent') {
      const result = await ownerCall(f, active, 'recover', { expectedDigest });
      assert.equal(result.body.data.phase, 'committing');
      assert.deepEqual(result.body.needsOriginalOwnerBindings, ['old-pr']);
    } else await assert.rejects(ownerCall(f, active, 'recover', { expectedDigest }), /binding|receipt|version/);
    assert.deepEqual(await f.storage.list(), before, `${drift} cannot silently settle or discard an obligation`);
    assert.equal(f.reads(), 0); assert.equal(f.sent.length, 0);
  }
});

test('terminal settlement resumes a crash prefix and release rejects a reopened or changed canonical task', async t => {
  const f = migrationFixture(), source = { ...frozenSource(), tasks: frozenSource().tasks.slice(0, 1) };
  seed(f, source);
  let active = await f.module.create(manifest).start(f.host); t.after(() => active.stop({ reason: 'test' }));
  const staged = await ownerCall(f, active, 'stage', { snapshot: source, expectedDigest: sourceDigest(source) });
  const expectedDigest = staged.body.data.planDigest;
  await ownerCall(f, active, 'commit', { expectedDigest });
  const closed = { ...f.tasks.get('old-pr')!, status: 'done' as const, updatedAt: 12 };
  f.tasks.set('old-pr', closed);
  const remove = f.storage.delete.bind(f.storage);
  f.storage.delete = async () => { throw new Error('Synthetic interruption after durable history'); };
  await assert.rejects(ownerCall(f, active, 'recover', { expectedDigest }), /Synthetic interruption/);
  f.storage.delete = remove;
  await active.stop({ reason: 'restart after interrupted retirement' });
  active = await f.module.create(manifest).start(f.host);
  assert.equal((await ownerCall(f, active, 'recover', { expectedDigest })).body.data.phase, 'committed');
  f.tasks.set('old-pr', { ...closed, status: 'doing', updatedAt: 13 });
  await assert.rejects(ownerCall(f, active, 'release', { expectedDigest }), /binding/);
  assert.equal((await ownerCall(f, active, 'status')).body.data.phase, 'committed');
  assert.equal(f.reads(), 0); assert.equal(f.sent.length, 0);
});

test('pending old outcome needs a conclusive source receipt; definitive no-send recovers only after native binding and release', async t => {
  const source = frozenSource(), base = source.tasks[0]!;
  const pending: TaskItem = { ...base, status: 'done', automationState: { waitOutcome: { v: 1, generation: 27,
    subjectRef: 'pr:example/project#12', ownerFence: { kind: 'containing_task', generation: 27 }, outcomeId: 'original-outcome',
    at: 800, reason: 'matched', delivery: 'pending', matched: [{ kind: 'pr_head_changed', delta: 'original already matched fact', sourceRef: 'github:original-observation' }] } } };
  const f = migrationFixture(), snapshot: MigrationSource = { ...source, tasks: [pending] }; seed(f, snapshot);
  const active = await f.module.create(manifest).start(f.host); t.after(() => active.stop({reason:'test'}));
  await assert.rejects(ownerCall(f, active, 'stage', {snapshot, expectedDigest:sourceDigest(snapshot)}), /authoritative receipt/);
  assert.equal(Object.keys(await f.storage.list()).length,0);
  const ambiguous: MigrationSource = { ...snapshot, receipts: [{ taskId: pending.id, outcomeId: 'original-outcome', sourceRef: 'original:ledger',
    disposition: 'ambiguous', messageAppended: true, wakeAccepted: false }] };
  await assert.rejects(ownerCall(f, active, 'stage', {snapshot:ambiguous, expectedDigest:sourceDigest(ambiguous)}), /Ambiguous/);
  const exact: MigrationSource = { ...snapshot, receipts: [{ taskId: pending.id, outcomeId: 'original-outcome', sourceRef: 'original:ledger',
    disposition: 'not-delivered', messageAppended: false, wakeAccepted: false }] };
  const staged=await ownerCall(f,active,'stage',{snapshot:exact,expectedDigest:sourceDigest(exact)}),digest=staged.body.data.planDigest;
  await ownerCall(f,active,'commit',{expectedDigest:digest}); assert.equal(f.sent.length,0);
  await active.actions['github.migration.bind-wait']!({taskId:pending.id,expectedDigest:digest},f.caller);
  await ownerCall(f,active,'recover',{expectedDigest:digest}); assert.equal(f.sent.length,0);
  await ownerCall(f,active,'release',{expectedDigest:digest});
  await ownerCall(f,active,'release',{expectedDigest:digest});
  assert.equal(f.sent.length,1); assert.equal(f.reads(),0,'an already matched outcome needs no fresh GitHub baseline');
});

test('legacy pending wake requires the exact message receipt and cannot skip its old terminal obligation',async t=>{
  const source=frozenSource(), old=source.tasks.find(task=>task.id==='old-issue')!;
  const task:TaskItem={...old,automationState:{issue:{lastCommentCursor:24,lastDeliveredCursor:23,issueState:'open',
    pendingWake:{messageId:'pending-message',threadId:old.threadId,catId:old.ownerCatId!,content:'Synthetic only',deliveredCursor:24}}}};
  const receipt={taskId:task.id,sourceRef:'original:exact-message-receipt',disposition:'delivered' as const,messageAppended:true,wakeAccepted:true};
  const f=migrationFixture(),active=await f.module.create(manifest).start(f.host);t.after(()=>active.stop({reason:'test'}));
  const cut=(messageId?:string,close=false):MigrationSource=>({...source,tasks:[{...task,automationState:{issue:{...task.automationState!.issue!,
    pendingWake:{...task.automationState!.issue!.pendingWake!,closeTaskAfterWake:close}}}}],
    receipts:[{...receipt,...(messageId?{messageId}:{})} as MigrationSource['receipts'][number]]});
  seed(f,cut('other-message'));
  const stage=(snapshot:MigrationSource)=>ownerCall(f,active,'stage',{snapshot,expectedDigest:sourceDigest(snapshot)});
  await assert.rejects(stage(cut()),/message receipt mismatch/);
  await assert.rejects(stage(cut('other-message')),/message receipt mismatch/);
  await assert.rejects(stage(cut('pending-message',true)),/terminal obligation/);
  assert.equal(Object.keys(await f.storage.list()).length,0);
  assert.equal((await stage(cut('pending-message'))).body.data.phase,'staged');
});

test('source inspection is read-only and reports hidden producer fields instead of calling reduced SDK Tasks a complete export',async t=>{
  const f=migrationFixture(),source=frozenSource();seed(f,source);
  const active=await f.module.create(manifest).start(f.host);t.after(()=>active.stop({reason:'test'}));
  const before=await f.storage.list();
  const result=await ownerCall(f,active,'source') as unknown as {body:{data:{complete:boolean;unavailable:Array<{fields:string[]}>}}};
  assert.equal(result.body.data.complete,false);
  assert.ok(result.body.data.unavailable.some(f=>f.fields.includes('typedWaitRegistration')));
  assert.deepEqual(await f.storage.list(),before);
  assert.ok(!manifest.features[0].capabilities.includes('thread.readContent'));
});

test('freeze uses two read-only cuts, rejects drift/unknown and retains opaque authority references without converting them', async () => {
  const source = frozenSource(); let reads = 0;
  const cut = await freezeGitHubSource({ read: async () => { reads++; return source; } }, signal);
  assert.equal(reads, 2); assert.equal(cut.digest, sourceDigest(source));
  await assert.rejects(freezeGitHubSource({ read: async () => ({ ...source, coverage: { ...source.coverage, 'pending-receipts': 'unknown' } }) }, signal), /Incomplete/);
  let sequence = 0;
  await assert.rejects(freezeGitHubSource({ read: async () => ({ ...source, id: String(++sequence) }) }, signal), /changed during freeze/);
});

test('abort fences stage recovery; active owner drift and ambiguous pending receipts cause no active writes', async t => {
  const f = migrationFixture(), source = frozenSource(); seed(f, source);
  const active = await f.module.create(manifest).start(f.host); t.after(() => active.stop({ reason: 'test' }));
  const s = await ownerCall(f, active, 'stage', { snapshot: source, expectedDigest: sourceDigest(source) });
  const digest = s.body.data.planDigest;
  await ownerCall(f, active, 'abort', { expectedDigest: digest }); const before = await f.storage.list();
  await assert.rejects(ownerCall(f, active, 'recover', { expectedDigest: digest }), /aborted/);
  assert.deepEqual(await f.storage.list(), before);
  const g = migrationFixture(); seed(g, source); const second = await g.module.create(manifest).start(g.host); t.after(() => second.stop({reason:'test'}));
  const stage = await ownerCall(g, second, 'stage', { snapshot: source, expectedDigest: sourceDigest(source) });
  g.tasks.set('old-pr', { ...g.tasks.get('old-pr')!, ownerCatId: 'replacement' });
  await assert.rejects(ownerCall(g, second, 'commit', { expectedDigest: stage.body.data.planDigest }), /binding\/version/);
  assert.equal(Object.keys(await g.storage.list()).some(k => k.startsWith('github.typed-wait.v1.')), false);
});

test('migration owner entry refuses anonymous and native calls without writing a stage', async t => {
  const f = migrationFixture(), active = await f.module.create(manifest).start(f.host);
  t.after(() => active.stop({ reason: 'test' }));
  assert.equal(typeof active.actions['github.migration.stage'], 'function', 'ordinary owner stage is missing');
  const before = await f.storage.list();
  await assert.rejects(async () => active.actions['github.migration.stage']!({ request: { principal: { kind: 'owner', id: 'owner' }, body: {} } }), /owner/i);
  await assert.rejects(async () => active.actions['github.migration.stage']!({}, f.caller), /owner/i);
  assert.deepEqual(await f.storage.list(), before);
});

test('lost first Host binding response is recoverable without incrementing or replacing generation', async t => {
  const f = migrationFixture(), source = frozenSource(); seed(f, source);
  const original = f.host.tasks.update; let lost = true;
  f.host.tasks.update = async (...args) => {
    const result = await original(...args);
    if (lost) { lost = false; throw new Error('Host response lost after commit'); }
    return result;
  };
  const active = await f.module.create(manifest).start(f.host); t.after(() => active.stop({reason:'test'}));
  const staged = await ownerCall(f, active, 'stage', { snapshot: source, expectedDigest: sourceDigest(source) });
  const digest = staged.body.data.planDigest;
  await ownerCall(f, active, 'commit', { expectedDigest: digest });
  const input = { taskId: 'old-pr', expectedDigest: digest };
  await assert.rejects(async () => active.actions['github.migration.bind-wait']!(input, f.caller), /response lost/);
  await active.actions['github.migration.bind-wait']!(input, f.caller);
  assert.equal(f.tasks.get('old-pr')?.pluginWait?.generation, 27);
  assert.equal((await ownerCall(f, active, 'recover', { expectedDigest: digest })).body.data.phase, 'committed');
});

test('release refuses a Host projection removed after commit, while retaining import hold', async t => {
  const f = migrationFixture(), source = frozenSource(); seed(f, source);
  const active = await f.module.create(manifest).start(f.host); t.after(() => active.stop({reason:'test'}));
  const staged = await ownerCall(f, active, 'stage', { snapshot: source, expectedDigest: sourceDigest(source) });
  const digest = staged.body.data.planDigest;
  await ownerCall(f, active, 'commit', { expectedDigest: digest });
  await active.actions['github.migration.bind-wait']!({ taskId: 'old-pr', expectedDigest: digest }, f.caller);
  await ownerCall(f, active, 'recover', { expectedDigest: digest });
  const host = f.tasks.get('old-pr')!; const {pluginWait: _removed, ...without} = host; f.tasks.set(host.id, without);
  await assert.rejects(ownerCall(f, active, 'release', { expectedDigest: digest }), /binding|projection/i);
  await assert.rejects(async () => active.actions['github.pr-tracking']!({}), /import.*hold/i);
  assert.equal(f.reads(), 0); assert.equal(f.sent.length, 0);
});

test('stage and active-copy interruptions recover the same source prefix without exposing a collector',async t=>{
  const f=migrationFixture(),source=frozenSource();seed(f,source);
  const cas=f.host.storage.compareAndSet.bind(f.host.storage);let interrupted=false;
  f.host.storage.compareAndSet=async(key,revision,value)=>{
    if(!interrupted && key.startsWith('github.migration.stage.')){interrupted=true;await cas(key,revision,value);throw new Error('stage response lost');}
    return cas(key,revision,value);
  };
  let active=await f.module.create(manifest).start(f.host);t.after(()=>active.stop({reason:'test'}));
  await assert.rejects(ownerCall(f,active,'stage',{snapshot:source,expectedDigest:sourceDigest(source)}),/response lost/);
  await active.stop({reason:'restart'});active=await f.module.create(manifest).start(f.host);
  const staged=await ownerCall(f,active,'stage',{snapshot:source,expectedDigest:sourceDigest(source)}),digest=staged.body.data.planDigest;
  let lost=false;f.host.storage.compareAndSet=async(key,revision,value)=>{
    if(!lost && key.startsWith('github.typed-wait.')){lost=true;await cas(key,revision,value);throw new Error('active copy response lost');}
    return cas(key,revision,value);
  };
  await assert.rejects(ownerCall(f,active,'commit',{expectedDigest:digest}),/active copy response lost/);
  await active.stop({reason:'restart'});active=await f.module.create(manifest).start(f.host);
  const recovered=await ownerCall(f,active,'recover',{expectedDigest:digest});
  assert.equal(recovered.body.data.phase,'committing');
  assert.deepEqual(recovered.body.needsOriginalOwnerBindings,['old-pr']);
  assert.equal(f.reads(),0);assert.equal(f.sent.length,0);
});

test('owner revocation during stage retains an inert recoverable prefix and cannot write active state',async t=>{
  const f=migrationFixture(),source=frozenSource();seed(f,source);
  const cas=f.host.storage.compareAndSet.bind(f.host.storage);let revoked=false;
  f.host.storage.compareAndSet=async(...args)=>{const result=await cas(...args);if(args[0]==='github.migration.control.v1')revoked=true;return result;};
  const active=await f.module.create(manifest).start(f.host);t.after(()=>active.stop({reason:'test'}));
  const owner={...f.owner(),assertCurrent:async()=>{if(revoked)throw new Error('owner revoked');}};
  await assert.rejects(async()=>active.actions['github.migration.stage']!({request:{method:'POST',path:'github/migration/stage',
    principal:{kind:'owner',id:'owner'},body:{snapshot:source,expectedDigest:sourceDigest(source)}}},undefined,owner),/owner revoked/);
  assert.equal(Object.keys(await f.storage.list()).some(k=>k.startsWith('github.typed-wait.')),false);
});

test('repository import preserves separate notification and guard routes, old dedup and repeated ordinary deliveries',async t=>{
  const f=migrationFixture(),source=frozenSource();seed(f,source);
  const snapshot:MigrationSource={...source,tasks:[],repositories:[{config:{repo:'example/project',guardThreadId:'thread',guardCatId:'cat',reviewMode:'observe_only',cloudReviewPolicy:'optional',createdAt:1,updatedAt:2},
    notificationRoute:{threadId:'original-inbox',userId:'owner'},
    progress:{'f141:baseline:example/project':'1','f141:notified:example/project#pr-12':'1','community:repo-comment:cursor:example/project':'2026-10-21T00:00:00.000Z'},
    commentOverlapEventIds:['comment:example/project#42:23']}]};
  f.host.secrets.get=async key=>key==='webhookSecret'?'isolated-webhook-secret':undefined;
  const module=createGitHubPluginModule({now:()=>1000,createCommunityProvider:()=>({
    listOpen:async()=>[{kind:'pr',number:13,title:'New fact',url:'https://github.com/example/project/pull/13',author:'external',authorAssociation:'CONTRIBUTOR',draft:false}],
    repoComments:async()=>[],state:async()=>null,selfLogin:()=>undefined,
  })});
  const active=await module.create(manifest).start(f.host);t.after(()=>active.stop({reason:'test'}));
  for(const route of [null,{threadId:'original-inbox',userId:'another-owner'},{threadId:'original-inbox',userId:'owner',extra:'unapproved'}]) {
    const invalid={...snapshot,repositories:[{...snapshot.repositories[0]!,notificationRoute:route}]};
    await assert.rejects(ownerCall(f,active,'stage',{snapshot:invalid,expectedDigest:sourceDigest(invalid)}),/notification route/);
    assert.equal(Object.keys(await f.storage.list()).length,0);
  }
  const staged=await ownerCall(f,active,'stage',{snapshot,expectedDigest:sourceDigest(snapshot)});
  await ownerCall(f,active,'commit',{expectedDigest:staged.body.data.planDigest});
  const journal=new SdkCommunityEventLog(f.storage);
  const result=await journal.append({sourceEventId:'comment:example/project#42:23',subjectKey:'issue:example/project#42',kind:'issue.commented',classification:'informational',payload:{commentId:23},at:1});
  assert.equal(result.appended,false);assert.deepEqual(await journal.read('issue:example/project#42'),[]);
  await ownerCall(f,active,'release',{expectedDigest:staged.body.data.planDigest});
  await active.actions['github.repo-scan']!({});await active.actions['github.repo-scan']!({});
  assert.equal(f.sent.length,1);
  assert.equal((f.sent[0] as {threadId:string}).threadId,'original-inbox');
  const {SdkCommunityRepoConfigStore}=await import('./business/domains/community/CommunityRepoConfigStore.js');
  assert.equal((await new SdkCommunityRepoConfigStore(f.storage).getByRepo('example/project'))?.guardThreadId,'thread');
  const body=Buffer.from(JSON.stringify({action:'opened',repository:{full_name:'example/project'},issue:{number:14,title:'Webhook fact',html_url:'https://github.com/example/project/issues/14',user:{login:'external'},author_association:'CONTRIBUTOR'}}));
  const headers={'x-github-event':'issues','x-github-delivery':'isolated-new-webhook','x-hub-signature-256':'sha256='+createHmac('sha256','isolated-webhook-secret').update(body).digest('hex')};
  const webhook={request:{method:'POST',headers,rawBody:body}};
  await active.actions['github.webhook']!(webhook);await active.actions['github.webhook']!(webhook);
  assert.equal(f.sent.length,2);assert.equal((f.sent[1] as {threadId:string}).threadId,'original-inbox');
  const configs=new SdkCommunityRepoConfigStore(f.storage);
  await configs.upsert({...snapshot.repositories[0]!.config,reviewMode:'maintainer_review'});
  assert.equal((await configs.getByRepo('example/project'))?.notificationThreadId,'original-inbox');
  await configs.upsert({...snapshot.repositories[0]!.config,guardThreadId:'new-owner-selected-thread'});
  assert.equal((await configs.getByRepo('example/project'))?.notificationThreadId,undefined);
});

test('aborted stage admits an explicit new cut in the same instance but refuses delayed completion from the old plan',async t=>{
  const f=migrationFixture(),source=frozenSource();seed(f,source);
  const active=await f.module.create(manifest).start(f.host);t.after(()=>active.stop({reason:'test'}));
  const first=await ownerCall(f,active,'stage',{snapshot:source,expectedDigest:sourceDigest(source)});
  await ownerCall(f,active,'abort',{expectedDigest:first.body.data.planDigest});
  const recut={...source,id:'explicit-new-frozen-cut'};
  const second=await ownerCall(f,active,'stage',{snapshot:recut,expectedDigest:sourceDigest(recut)});
  assert.notEqual(second.body.data.planDigest,first.body.data.planDigest);
  await assert.rejects(ownerCall(f,active,'commit',{expectedDigest:first.body.data.planDigest}),/Exact migration/);
  assert.equal(f.reads(),0);assert.equal(f.sent.length,0);
});

test('expired owner-readable legacy history without a persisted user neither rearms nor blocks the valid successor on the same subject',async t=>{
  const f=migrationFixture(),source=frozenSource();
  const old=source.tasks[2]!,{userId:_historicalUser,...withoutUser}=old;
  const historical:TaskItem={...withoutUser,subjectKey:'issue:example/project#42',automationState:{await:{...old.automationState!.await!,subjectRef:'issue:example/project#42'} as GitHubIssueAwaitStateV1}};
  const snapshot={...source,tasks:[source.tasks[0]!,source.tasks[1]!,historical]};seed(f,snapshot);
  f.tasks.set(historical.id,{...f.tasks.get(historical.id)!,userId:null});
  const active=await f.module.create(manifest).start(f.host);t.after(()=>active.stop({reason:'test'}));
  const result=await ownerCall(f,active,'stage',{snapshot,expectedDigest:sourceDigest(snapshot)});
  assert.equal(result.body.data.phase,'staged');assert.equal(f.tasks.get(historical.id)?.pluginWait,undefined);
});
