import { expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { BROWSER_SERVICE_LIMITS, type PluginTaskReadItem, type ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import entrypoint from '../../../plugin-entrypoint.js';
import { fixture } from './communication-work-custody.fixture.js';
import { ownerRequestExecution } from '../../../collective-owner-request-progress.js';

const manifest = parse(await readFile(new URL('../../../../plugin.yaml', import.meta.url), 'utf8'));

test('original owner page shows ordinary Work in its private thread and accepted closure', async () => {
  const f = await setup();
  try {
    await f.connector.adoptWorkPolicy(f.connection.connectionId, 'local-owner', f.policy.revision);
    const work = await f.connector.acceptWork(f.source, f.agent, f.input);
    await f.connector.sync(f.connection.connectionId);
    const route = (await f.connector.getHostRoute(f.connection.connectionId))!;
    await f.connector.beginInboxRouting(f.connection.connectionId, work.assignmentEventId!, route.revision);
    await f.connector.completeInboxRouting(f.connection.connectionId, work.assignmentEventId!, route.revision,
      {kind: 'thread_message', messageId: 'ordinary-assignment', threadId: 'channel', catId: 'codex-sol'});
    f.rows.push({id: 'private-work', title: 'Original private Work', createdBy: 'local-owner', participants: ['codex-sol']});
    const task: PluginTaskReadItem = {id: 'ordinary-task', kind: 'work', title: work.title, why: work.intendedOutcome,
      subjectKey: `collective-work:${f.connection.connectionId}:${work.workId}`, threadId: 'private-work',
      ownerCatId: 'codex-sol', userId: null, createdBy: 'system', status: 'doing', createdAt: 1, updatedAt: 7};
    f.tasks.push(task, {...task, id: 'wrong-cat', ownerCatId: 'other-cat'});
    // A second Connector instance seeded the event; reopen the module to load
    // its persisted inbox, just as the existing restart fixtures do.
    await f.restart();
    expect(f.subscriptions.has('private-work')).toBe(true);
    const result = await f.invoke() as {status: number; body: {tasks: unknown[]}};
    expect(result.status).toBe(200);
    expect(result.body.tasks).toContainEqual({id: task.id, title: task.title, threadId: 'private-work', status: 'doing',
      revision: 7, closure: 'open', sourceRefs: ['message:ordinary-assignment']});
    expect(result.body.tasks).not.toContainEqual(expect.objectContaining({id: 'wrong-cat'}));
    f.tasks[f.tasks.indexOf(task)] = {...task, status: 'done', updatedAt: 8};
    const closed = await f.invoke() as {status: number; body: {tasks: unknown[]}};
    expect(closed.body.tasks).toContainEqual(expect.objectContaining({id: task.id, closure: 'satisfied', revision: 8}));
  } finally {await f.close();}
});

test('the original browser accepted-result operation has an owner webhook declaration', () => {
  const declaration = manifest.contributions.find((c: {path?: string}) => c.path === 'connections/:connectionId/work/result/accepted');
  expect(declaration).toMatchObject({type: 'webhook', methods: ['POST'], action: {method: 'collective.work.control.http'}});
  expect(manifest.features.find((f: {id: string}) => f.id === 'collective-work').contributions)
    .toContainEqual({type: 'webhook', id: declaration.id});
});
async function setup(taskHost?: ModulePluginHostShape['tasks'], sourceFactory?: (f: Awaited<ReturnType<typeof fixture>>,
  current: () => Promise<void>) => Promise<{ messageId: string; port: NonNullable<ModulePluginHostShape['sourceFacts']> }>) {
  const f = await fixture(); let stale = false, reads = 0, bodyReads = 0;
  let progressQueue: { status: 'queued' | 'processing' | 'terminal'; allTargetCats: string[]; handledByCatIds: string[];
    failedByCatIds: string[]; seenByCatIds: string[]; targetOutcomeByCatId?: Record<string, { handledAt: number }> } | undefined;
  const current = async () => { if (stale) throw new Error('Owner view expired'); };
  const external = await sourceFactory?.(f, current);
  const sourceMessageId = external?.messageId ?? 'view-source';
  await f.connector.sync(f.connection.connectionId);
  const route = (await f.connector.getHostRoute(f.connection.connectionId))!;
  await f.connector.beginInboxRouting(f.connection.connectionId, f.source.eventId, route.revision);
  await f.connector.completeInboxRouting(f.connection.connectionId, f.source.eventId, route.revision,
    { kind: 'thread_message', messageId: sourceMessageId, threadId: 'channel', catId: 'codex-sol' });
  const rows = [{ id: 'channel', title: 'Owner channel', createdBy: 'local-owner', participants: ['codex-sol'] },
    { id: 'foreign', title: 'Foreign private', createdBy: 'foreign-owner', participants: ['codex-sol'] }];
  const subscriptions = new Set<string>();
  const unused = async (): Promise<never> => { throw new Error('Read must not invoke an unrelated Host port'); };
  const base: PluginTaskReadItem = { id: 'owned-task', title: 'Original entrusted work', threadId: 'channel',
    kind: 'work', subjectKey: null, status: 'doing', ownerCatId: null, why: '', createdBy: 'local-owner',
    createdAt: 1, updatedAt: 1, userId: 'local-owner',
    entrustedWork: { revision: 3, closure: { state: 'open' }, admission: { sourceRefs: [`message:${sourceMessageId}`] } } };
  const tasks: PluginTaskReadItem[] = [base, { ...base, id: 'foreign-task', userId: 'foreign-owner' },
    { ...base, id: 'unrelated-task', entrustedWork: { ...base.entrustedWork!, admission: { sourceRefs: ['message:other'] } } },
    { ...base, id: 'legacy-unowned-task', userId: null }];
  const host: ModulePluginHostShape = { pluginInstanceId: 'installed-instance', dataDirectory: f.root, config: { async get() {} }, secrets: { async get() { return undefined; } }, storage: { get: unused, list: unused, set: unused, compareAndSet: unused, delete: unused },
    media: { read: unused }, messaging: { send: unused,
      async subscribe({threadId}) {expect(rows.find(row => row.id === threadId)?.createdBy).toBe('local-owner');subscriptions.add(threadId);},
      async unsubscribe({threadId}) {subscriptions.delete(threadId);}}, log() {},
    tasks: taskHost ?? { get: unused, listByThread: unused, getBySubject: unused, create: unused, upsertBySubject: unused,
      update: unused, updateIfThreadId: unused, setWait: unused,
      async listByKind(kind) { await current(); expect(kind).toBe('work'); reads++; return tasks; } },
    threads: { get: unused, readMessages: unused, getCats: unused, create: unused, update: unused, findByKey: unused,
      ensureByKey: unused, bind: unused, unbind: unused, listBindings: unused, ensureSystemThread: unused,
      async list(options: { limit?: number; before?: { lastActiveAt: number; id: string } } = {}) {
      await current(); return rows.map((r, i) => ({ ...r, deepLinkUrl: '/thread/' + r.id, createdAt: 1,
        lastActiveAt: rows.length - i, preferredCats: [], featureRefs: [] }))
        .filter(r => !options.before || r.lastActiveAt < options.before.lastActiveAt ||
          (r.lastActiveAt === options.before.lastActiveAt && r.id > options.before.id)).slice(0, options.limit ?? 50);
    } },
    ownerThreads: { async get(id: string) { await current(); const r = rows.find(r => r.id === id);
      return r ? { id: r.id, createdBy: r.createdBy, participants: r.participants } : null;
    }, async create() { throw new Error('Read must not create'); }, async addParticipants() { throw new Error('Read must not mutate'); } },
    sourceFacts: external?.port ?? { async read() { bodyReads++; throw new Error('Owner progress must not read message body'); },
      async readProgress() { await current(); return { id: 'view-source', threadId: 'channel', userId: 'local-owner', catId: null,
      ...(progressQueue ? { queueCustody: progressQueue } : {}), source: { connector: 'collective', meta: { participation: f.source } }, extra: { pluginMessage: { instanceId: 'fixture' } } }; } },
    participantRoster: { async listForNativeContribution() { await current(); return [{ catId: 'codex-sol', displayName: 'Sol', defaultModel: 'fixture', supported: true }]; } },
    nativeContext: { async current() { throw new Error('Owner GET must not borrow native identity'); } },
    browserServices: { async getBinding(id: string) { return { contributionId: id, origin: 'http://127.0.0.1:5271', parentOrigin: 'http://localhost:5172',
      clientBuildId: 'collective-client-v2', assetDigest: 'a'.repeat(64), limits: BROWSER_SERVICE_LIMITS, assertCurrent: current }; },
      async dispatchLocal() { throw new Error('Unused'); } } };
  let active = await entrypoint.create(manifest).start(host);
  // Work activation restores subscriptions with a permitted metadata read.
  // The counters below measure only the subsequent owner HTTP request.
  reads = 0;
  return { ...f, get active() {return active;}, tasks, rows, subscriptions, async restart() {await active.stop();active = await entrypoint.create(manifest).start(host);reads = 0;}, get reads() { return reads; }, get bodyReads() { return bodyReads; }, setProgress(queue: typeof progressQueue) { progressQueue = queue; }, expire() { stale = true; },
    invoke(owner = 'local-owner', native?: unknown) { return active.actions['collective.control.http']!({ request: { method: 'GET',
      path: `connections/${f.connection.connectionId}/participation`, headers: { origin: 'http://localhost:5172' },
      principal: { kind: 'owner', id: owner } } }, native as never); }, async close() { await active.stop(); await f.close(); } };
}
test('retained GET participation and original read-only Task dependency are declared', () => {
  const c = manifest.contributions.find((c: { path?: string }) => c.path === 'connections/:connectionId/participation');
  expect(c).toMatchObject({ type: 'webhook', methods: ['GET', 'PUT'], action: { method: 'collective.control.http' } });
  expect(manifest.features[0].contributions).toContainEqual({ type: 'webhook', id: c.id });
  expect(manifest.features[0].capabilities).toContain('task.read');
  expect(manifest.features[0].capabilities).not.toContain('task.write');
});
test('actual GET retains owner threads, requests, admitted-source Task filtering and policy without mutation', async () => {
  const f = await setup(); try {
    const before = await f.connector.getHostRoute(f.connection.connectionId);
    const result = await f.invoke() as { status: number; body: any };
    expect(result.status, JSON.stringify(result)).toBe(200);
    expect(result.body).toMatchObject({ connection: { connectionId: f.connection.connectionId }, revision: before!.revision,
      cats: [{ id: 'codex-sol', configured: true, eligible: true }], threads: [{ id: 'channel', title: 'Owner channel', participants: ['codex-sol'] }],
      requests: [{ messageId: 'view-source', privateThread: { id: 'channel', title: 'Owner channel' } }],
      tasks: [{ id: 'owned-task', revision: 3, closure: 'open', sourceRefs: ['message:view-source'] }] });
    expect(result.body.tasks).toHaveLength(1); expect(result.body.threads).toHaveLength(1);
    expect(result.body.requests[0]).not.toHaveProperty('execution'); // Current Host omits queue facts: no fabricated progress.
    expect(await f.connector.getHostRoute(f.connection.connectionId)).toEqual(before); expect(f.reads).toBe(1);
  } finally { await f.close(); }
});
test('foreign owner and native caller are refused before owner view reads', async () => {
  const f = await setup(); try {
    expect(await f.invoke('foreign-owner')).toMatchObject({ status: 403, body: { code: 'CONNECTOR_OWNER_MISMATCH' } });
    await expect(f.invoke('local-owner', { userId: 'local-owner' })).rejects.toThrow(/webhook/);
    expect(f.reads).toBe(0);
  } finally { await f.close(); }
});
test('expired view and disposed feature cannot return cached owner data', async () => {
  const f = await setup(); try {
    f.expire(); await expect(f.invoke()).rejects.toThrow(/expired/);
    expect(f.reads).toBe(0);
  } finally { await f.close(); }
});
test('the existing fifty-row Host cursor preserves the complete owned-thread selection', async () => {
  const f = await setup(); try {
    for (let i = 0; i < 55; i++) f.rows.push({ id: `owned-${i}`, title: `Owner ${i}`, createdBy: 'local-owner', participants: [] });
    const result = await f.invoke() as { status: number; body: { threads: { id: string }[] } };
    expect(result.status).toBe(200); expect(result.body.threads).toHaveLength(56);
    expect(result.body.threads.at(-1)?.id).toBe('owned-54');
    expect(result.body.threads.some(t => t.id === 'foreign')).toBe(false);
  } finally { await f.close(); }
});
test('original progress stages require the exact owner/source/cat/connection and current Queue display facts', async () => {
  const f = await fixture(); try {
    await f.connector.sync(f.connection.connectionId);
    const item = (await f.connector.listInbox(f.connection.connectionId)).find(item => item.event.eventId === f.source.eventId)!;
    const request = { ...item, routeReceipt: { kind: 'thread_message' as const, threadId: 'channel', messageId: 'source', catId: 'codex-sol' } };
    const thread = { id: 'channel', title: 'Owner', createdBy: 'local-owner', participants: ['codex-sol'] };
    const message = { id: 'source', userId: 'local-owner', threadId: 'channel', source: { connector: 'collective', meta: { participation: f.source } },
      queueCustody: { status: 'queued' as const, allTargetCats: ['codex-sol'], handledByCatIds: [] as string[],
        failedByCatIds: [] as string[], seenByCatIds: [] as string[] } };
    const read = () => ownerRequestExecution(request, thread, { async getById() { return message; } }, 'local-owner', f.connection.connectionId);
    expect(await read()).toEqual({ stage: 'queued' });
    message.queueCustody.seenByCatIds = ['codex-sol']; expect(await read()).toEqual({ stage: 'started' });
    message.queueCustody.failedByCatIds = ['codex-sol']; expect(await read()).toEqual({ stage: 'failed' });
    message.queueCustody.handledByCatIds = ['codex-sol']; expect(await read()).toEqual({ stage: 'ended' });
    message.userId = 'foreign-owner'; expect(await read()).toBeUndefined(); message.userId = 'local-owner';
    message.queueCustody.allTargetCats = ['foreign-cat']; expect(await read()).toBeUndefined();
    message.queueCustody.allTargetCats = ['codex-sol'];
    expect(await ownerRequestExecution(request, thread, { async getById() { return message; } }, 'local-owner', 'another-connection')).toBeUndefined();
  } finally { await f.close(); }
});


test('an absent stable Task owner projection fails visibly instead of returning an empty owner view', async () => {
  const f = await setup(); try {
    const legacy = { ...f.tasks[0]! };
    Reflect.deleteProperty(legacy, 'userId');
    f.tasks[0] = legacy;
    const response = await f.invoke() as { status: number; body: { error?: string } };
    expect(response.status).toBe(409);
    expect(JSON.stringify(response.body)).toMatch(/Task read.*userId/);
  } finally { await f.close(); }
});

// Cross-repository acceptance explicitly supplies the reviewed compiled Host module.
// Ordinary package tests exercise the same declared projection using the typed fixture above.
if (process.env.C1_TASK_READ_HOST_MODULE) test('compiled Host four read ports cross the SDK and preserve the original owner Task summary', async () => {
  const { createPluginTaskHost } = await import(process.env.C1_TASK_READ_HOST_MODULE!);
  const base: PluginTaskReadItem = { id: 'actual-host-task', title: 'Original entrusted work', threadId: 'channel', kind: 'work',
    subjectKey: 'work:fixture', status: 'doing', ownerCatId: null, why: '', createdBy: 'local-owner', createdAt: 1,
    updatedAt: 1, userId: 'local-owner', pluginWait: { pluginInstanceId: 'installed-instance', generation: 2,
      await: { generation: 2, expiresAt: 9000 }, waitOutcome: { outcomeId: 'outcome-1', generation: 1,
        ownerFence: { kind: 'containing_task', generation: 1 }, reason: 'matched', delivery: 'delivered' } }, entrustedWork: { revision: 3, closure: { state: 'open' },
      admission: { sourceRefs: ['message:view-source'] } } };
  const raw = { ...base, privateHostField: 'not-visible', pluginWait: { ...base.pluginWait!,
    invalidated: true, userId: 'private-owner', catId: 'private-cat', threadId: 'private-thread',
    registration: { invocationId: 'private-invocation', source: { content: 'private-source' } },
    await: { ...base.pluginWait!.await!, registration: { source: 'private-await-source' } },
    waitOutcome: { ...base.pluginWait!.waitOutcome!, ownerFence: { ...base.pluginWait!.waitOutcome!.ownerFence, source: 'private-fence' } } }, entrustedWork: { ...base.entrustedWork!,
    admission: { ...base.entrustedWork!.admission, ownerReceipt: 'not-authority' }, execution: { grant: 'not-visible' } } };
  const legacy = { ...base, id: 'legacy-unowned' };
  Reflect.deleteProperty(legacy, 'userId'); Reflect.deleteProperty(legacy, 'entrustedWork');
  const taskHost: ModulePluginHostShape['tasks'] = createPluginTaskHost({ pluginId: 'official.collective-connector',
    ownerUserId: 'local-owner', readThreadStore: { async get(id: string) { return { id, createdBy: 'local-owner' }; } },
    effectiveGrants: ['task.read'], taskStore: { async get() { return raw; }, async getBySubject() { return raw; },
      async listByThread() { return [raw, legacy]; }, async listByKind() { return [raw, legacy]; } } });
  const results = [await taskHost.get(raw.id), await taskHost.getBySubject('work:fixture'),
    ...(await taskHost.listByThread('channel')), ...(await taskHost.listByKind('work'))];
  expect(results.filter(row => row?.id === raw.id)).toHaveLength(4);
  expect(results.filter(row => row?.id === legacy.id)).toHaveLength(2);
  for (const result of results.filter(row => row?.id === raw.id)) expect(result).toEqual(base);
  for (const result of results.filter(row => row?.id === legacy.id)) expect(result!.userId).toBeNull();
  await expect(taskHost.update(raw.id, { status: 'done' })).rejects.toThrow(/task.write/);
  const f = await setup(taskHost); try {
    const response = await f.invoke() as { status: number; body: { tasks: unknown[] } };
    expect(response.status, JSON.stringify(response)).toBe(200);
    expect(response.body.tasks).toEqual([{ id: raw.id, title: raw.title, threadId: 'channel', status: 'doing',
      revision: 3, closure: 'open', sourceRefs: ['message:view-source'] }]);
  } finally { await f.close(); }
});


test('actual owner GET consumes real Queue phases and per-target witnesses without ever reading queued content', async () => {
  const f = await setup(); try {
    const queue = { status: 'queued' as 'queued' | 'processing' | 'terminal', allTargetCats: ['codex-sol'],
      handledByCatIds: [] as string[], failedByCatIds: [] as string[], seenByCatIds: [] as string[] };
    f.setProgress(queue);
    const stage = async () => { const r = await f.invoke() as { status: number; body: { requests: { execution?: { stage: string } }[] } };
      expect(r.status).toBe(200); return r.body.requests[0]!.execution?.stage; };
    expect(await stage()).toBe('queued');
    queue.status = 'processing'; queue.seenByCatIds = ['codex-sol']; expect(await stage()).toBe('started');
    queue.status = 'terminal'; expect(await stage()).toBeUndefined();
    queue.seenByCatIds = []; expect(await stage()).toBeUndefined();
    queue.failedByCatIds = ['codex-sol']; expect(await stage()).toBe('failed');
    queue.handledByCatIds = ['codex-sol']; expect(await stage()).toBe('ended');
    queue.allTargetCats = ['foreign-cat']; expect(await stage()).toBeUndefined();
    f.setProgress(undefined); expect(await stage()).toBeUndefined();
    expect(f.bodyReads).toBe(0);
  } finally { await f.close(); }
});


if (process.env.C1_SOURCE_PROGRESS_HOST_ROOT) test('real compiled Queue and owner source reader drive the production retained GET stages', async () => {
  const base = process.env.C1_SOURCE_PROGRESS_HOST_ROOT!;
  const { MessageStore } = await import(`${base}/domains/cats/services/stores/ports/MessageStore.js`);
  const { createInitialQueuedMessageCustody } = await import(`${base}/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js`);
  const { settleQueueCustodyWithdrawal } = await import(`${base}/domains/cats/services/stores/ports/queued-message-custody.js`);
  const { createPluginSourceFactsHost } = await import(`${base}/domains/plugin/host-surface/plugin-source-facts-host.js`);
  const { withPluginOwnerRequest, withPluginOwnerWebhook } = await import(`${base}/domains/plugin/carrier/plugin-owner-request-context.js`);
  const owner = (operation: () => unknown) => withPluginOwnerRequest({ pluginId: 'official.collective-connector',
    contributionId: 'owner-view', userId: 'local-owner', operation: 'read', signal: new AbortController().signal },
    () => withPluginOwnerWebhook('official.collective-connector', 'owner-view', 'fixture', false, () => {}, operation));
  for (const stage of ['queued', 'started', 'failed', 'ended', 'withdrawn', 'withdrawn-seen']) {
    let bodyReads = 0;
    const f = await setup(undefined, async (fixture, current) => {
      const store = new MessageStore();
      const custody = createInitialQueuedMessageCustody({ id: 'entry', threadId: 'channel', userId: 'local-owner',
        ownerAuthProvenance: 'unknown', source: 'connector', content: 'private queued body', messageId: 'source',
        mergedMessageIds: [], targetCats: ['codex-sol'], allTargetCats: ['codex-sol'], intent: 'execute', autoExecute: true,
        status: 'queued', priority: 'normal', createdAt: 1000 });
      const message = store.append({ userId: 'local-owner', threadId: 'channel', catId: null, content: 'private queued body',
        mentions: ['codex-sol'], timestamp: 1000, deliveryStatus: 'queued', queueCustody: custody,
        source: { connector: 'collective', meta: { participation: fixture.source } },
        extra: { pluginMessage: { instanceId: 'fixture', revision: 1 } } });
      if (stage !== 'queued' && stage !== 'withdrawn') {
        const before = store.getById(message.id).queueCustody;
        const next = { ...before, revision: before.revision + 1, status: 'processing', updatedAt: 2000,
          seenByCatIds: ['codex-sol'], bodyExposures: [{ targetCatId: 'codex-sol', invocationId: 'private-child', seenAt: 1100 }],
          seenInvocationIdByCatId: { 'codex-sol': 'private-child' } };
        if (stage === 'failed') next.failedByCatIds = ['codex-sol'];
        if (stage === 'ended') Object.assign(next, { status: 'terminal', pendingTargetCats: [], handledByCatIds: ['codex-sol'],
          targetOutcomeByCatId: { 'codex-sol': { invocationId: 'private-child', disposition: 'completed_with_turn',
            evidenceRef: { kind: 'turn_execution', invocationId: 'private-child' }, handledAt: 2000 } } });
        expect(store.transitionQueueCustody(message.id, { expectedRevision: before.revision, next,
          ...(stage === 'ended' ? { deliveredAt: 2000 } : {}) }).kind).toBe('updated');
      }
      if (stage.startsWith('withdrawn')) {
        const before = store.getById(message.id).queueCustody;
        const next = settleQueueCustodyWithdrawal(before, ['codex-sol'], 3000);
        expect(next.status).toBe('terminal');
        expect(next.withdrawnByCatIds).toEqual(['codex-sol']);
        expect(store.transitionQueueCustody(message.id, { expectedRevision: before.revision, next, deliveredAt: 3000 }).kind).toBe('updated');
      }
      const host = createPluginSourceFactsHost({ pluginInstanceId: 'fixture', ownerUserId: 'local-owner',
        messageStore: { async getById(id: string) { return structuredClone(store.getById(id)); } },
        threadStore: { async get() { return { id: 'channel', createdBy: 'local-owner' }; } }, assertCurrent: current });
      return { messageId: message.id, port: { ...host.sourceFacts, async read() { bodyReads++; throw new Error('Must not read body'); } } };
    });
    try {
      const result = await owner(() => f.invoke()) as { status: number; body: { requests: { execution: { stage: string } }[] } };
      expect(result.status, JSON.stringify(result)).toBe(200);
      if (stage.startsWith('withdrawn')) expect(result.body.requests[0]).not.toHaveProperty('execution');
      else expect(result.body.requests[0]!.execution).toEqual({ stage });
      expect(JSON.stringify(result.body.requests)).not.toContain('private-child');
      expect(JSON.stringify(result.body.requests)).not.toContain('private queued body');
      expect(bodyReads).toBe(0);
    } finally { await f.close(); }
  }
});


test('a target outcome must be an own per-cat witness rather than an inherited object property', async () => {
  const f = await fixture(); try {
    await f.connector.sync(f.connection.connectionId);
    const item = (await f.connector.listInbox(f.connection.connectionId)).find(item => item.event.eventId === f.source.eventId)!;
    const catId = 'toString';
    const recipient = item.event.recipient; if (recipient?.kind !== 'agent') throw new Error('Expected original Agent recipient');
    const request = { ...item, event: { ...item.event, recipient: { ...recipient, agentId: catId } },
      routeReceipt: { kind: 'thread_message' as const, threadId: 'channel', messageId: 'source', catId } };
    const thread = { id: 'channel', title: 'Owner', createdBy: 'local-owner', participants: [catId] };
    const message = { id: 'source', userId: 'local-owner', threadId: 'channel',
      source: { connector: 'collective', meta: { participation: { ...f.source, catId } } },
      queueCustody: { status: 'queued' as const, allTargetCats: [catId], handledByCatIds: [], failedByCatIds: [],
        seenByCatIds: [], targetOutcomeByCatId: {} } };
    expect(await ownerRequestExecution(request, thread, { async getById() { return message; } },
      'local-owner', f.connection.connectionId)).toEqual({ stage: 'queued' });
  } finally { await f.close(); }
});
