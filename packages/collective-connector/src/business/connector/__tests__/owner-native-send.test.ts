import {memoryStorage, serviceHostConfig, ownerAction} from '../../../../test/runtime-fixture.js';
import { expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { type ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import entrypoint from '../../../plugin-entrypoint.js';
import { createCollectiveAgentVerification } from '../../../native-agent-verification.js';
import { CollectiveConnector } from '../connector.js';
import { fixture } from './communication-work-custody.fixture.js';

const manifest = parse(await readFile(new URL('../../../../plugin.yaml', import.meta.url), 'utf8'));
async function setup() {
  const f = await fixture(); let expired = false, nativeReads = 0, rosterReads = 0;
  let rows = [{ catId: 'codex-sol', displayName: 'Sol', defaultModel: 'fixture', available: true },
    { catId: 'other-cat', displayName: 'Other', defaultModel: 'fixture', available: true }];
  const host: ModulePluginHostShape = { pluginInstanceId: 'installed-instance', dataPath: f.root,
    config: serviceHostConfig(), secrets: { async get() { return undefined; } },
    storage: memoryStorage(), tasks: {list: async () => []} as never, streams:{read:async function*(){throw new Error('Unused stream port');}}, messaging: {} as never, log() {},
    members: { async get() { return null; }, async list() { rosterReads++; return structuredClone(rows); } },

    threads: {update:async()=>{throw new Error('Unused update');},readMessages:async()=>[],list:async()=>[], async get(id: string) { return { id } as never; }, async getCats() { return { participants: [{ catId: 'codex-sol' }] } as never; }, async create() { throw new Error('Unused'); }, async addParticipants() { throw new Error('Unused'); } },

  };
  const active = await entrypoint.create(manifest).start(host);
  const context = (overrides: Record<string, unknown> = {}) => ({ userId: 'local-owner', threadId: 'owner-thread', catId: 'codex-sol',
    invocationId: 'owner-native-invocation', ownerAuthProvenance: 'strict', originTriggerMessageId: 'owner-message',
    async assertCurrent() { if (expired) throw new Error('Owner invocation expired'); }, ...overrides });
  const state = async () => JSON.parse(await readFile(join(f.root, 'connector/collective-connector.json'), 'utf8'));
  const input = { connectionId: f.connection.connectionId, clientEventId: 'owner-message-operation', target: { kind: 'channel', channelId: 'general' }, body: 'Original owner signal' };
  return { ...f, active, context, state, input, get nativeReads() { return nativeReads; }, get rosterReads() { return rosterReads; },
    expire() { expired = true; }, restore() { expired = false; }, updateRows(value: typeof rows) { rows = value; },
    async invoke(body: unknown = input, caller: unknown = context()) { const action = active.actions['collective.connector.send']; expect(typeof action).toBe('function'); return action!(body, caller as never); },
    async close() { await active.stop({reason:'test'}); await f.close(); } };
}

test('owner send stays separate from the exact public context, Work and Artifact methods', () => {
  const owner = manifest.contributions.find((c: { id: string }) => c.id === 'collective-owner-native');
  expect(owner).toMatchObject({ type: 'mcp', actions: [{ method: 'collective.connector.send' }] });
  expect(manifest.features[0].contributions).toContainEqual({ type: 'mcp', id: owner.id });
  expect(manifest.contributions.find((c: { id: string }) => c.id === 'collective-native').actions
    .map((action: {method:string}) => action.method).sort()).toEqual([
      'collective.context.current', 'collective.context.read', 'collective.artifact.command',
      'collective.work.suggest-project', 'collective.participation.set-interest', 'collective.reply.submit',
      'collective.work.propose', 'collective.work.accept', 'collective.work.continue',
    ].sort());
});
test('actual module queues with authenticated owner and real Host profile without borrowing public nativeContext', async () => {
  const f = await setup(); try {
    const sent = await f.invoke(); expect(sent).toMatchObject({ disposition: 'queued', connection: { connectionId: f.connection.connectionId } });
    const state = await f.state(), outbox = state.connections[f.connection.connectionId].outbox;
    expect(outbox).toHaveLength(1); expect(outbox[0].agent).toMatchObject({ agentId: 'codex-sol', catId: 'codex-sol', displayName: 'Sol（fixture）', sessionRef: 'owner-native-invocation' });
    expect(outbox[0].body).toBe(f.input.body); expect(outbox[0].status).toBe('queued'); expect(f.nativeReads).toBe(0);
    await f.invoke(); expect((await f.state()).connections[f.connection.connectionId].outbox).toHaveLength(1);
    await expect(f.invoke({ ...f.input, body: 'Conflicting payload' })).rejects.toThrow(/another outbound message/);
  } finally { await f.close(); }
});
test('unknown/compatibility owner and every limited policy are refused before roster or queued effects', async () => {
  const f = await setup(); try {
    for (const ownerAuthProvenance of [undefined, 'unknown', 'compatibility_fallback'])
      await expect(f.invoke(f.input, f.context({ ownerAuthProvenance }))).rejects.toMatchObject({ code: 'CONNECTOR_OWNER_AUTHORITY_REQUIRED' });
    for (const toolExecutionPolicy of [{ mode: 'read_only', replayDeniedToolNames: [] }, { mode: 'callback_allowlist', allowedCallbackRoutes: [] },
      { mode: 'plugin_native', pluginInstanceId: 'instance', contributionId: 'collective-native', actionMethods: ['collective.connector.send'] }])
      await expect(f.invoke(f.input, f.context({ toolExecutionPolicy }))).rejects.toMatchObject({ code: 'EXACT_COLLECTIVE_RETURN_REQUIRED' });
    expect(f.rosterReads).toBe(0); expect((await f.state()).connections[f.connection.connectionId].outbox).toHaveLength(0);
  } finally { await f.close(); }
});
test('foreign owner, unavailable profile, body identity and purpose intents cannot queue', async () => {
  const f = await setup(); try {
    await expect(f.invoke(f.input, f.context({ userId: 'foreign-owner' }))).rejects.toMatchObject({ code: 'CONNECTOR_OWNER_MISMATCH' });
    for (const extra of [{ agent: { catId: 'fake' } }, { userId: 'local-owner' }, { sessionRef: 'forged' }, { workResultIntent: {} }, { workProgressIntent: {} }])
      await expect(f.invoke({ ...f.input, ...extra })).rejects.toMatchObject({ code: 'INVALID_COLLECTIVE_REQUEST' });
    f.updateRows([]); await expect(f.invoke()).rejects.toMatchObject({ code: 'AGENT_PROVENANCE_UNVERIFIED' });
    expect((await f.state()).connections[f.connection.connectionId].outbox).toHaveLength(0);
  } finally { await f.close(); }
});
test('profile change at verification and revoked feature/caller stop before queue without retries', async () => {
  const f = await setup(); try {
    const current = vi.fn(async () => { if (f.rosterReads >= 2) f.updateRows([{ catId: 'codex-sol', displayName: 'Changed', defaultModel: 'fixture', available: true }]); });
    await expect(f.invoke(f.input, f.context({ assertCurrent: current }))).rejects.toMatchObject({ code: 'AGENT_PROVENANCE_UNVERIFIED' });
    expect((await f.state()).connections[f.connection.connectionId].outbox).toHaveLength(0);
    f.expire(); await expect(f.invoke()).rejects.toThrow(/expired/);
    await f.active.stop({reason:'test'}); await expect(f.invoke()).rejects.toThrow(/revoked|stopped/);
  } finally { await f.close(); }
});
test('late owner revocation keeps the already queued effect and lost response retries the same outbox', async () => {
  const f = await setup(); const original = CollectiveConnector.prototype.queueAgentMessage;
  try {
    const spy = vi.spyOn(CollectiveConnector.prototype, 'queueAgentMessage').mockImplementation(async function (this: CollectiveConnector, ...args) {
      const result = await original.apply(this, args); f.expire(); return result;
    });
    await expect(f.invoke()).rejects.toThrow(/expired/); expect((await f.state()).connections[f.connection.connectionId].outbox).toHaveLength(1);
    spy.mockRestore(); f.restore(); await f.invoke(); expect((await f.state()).connections[f.connection.connectionId].outbox).toHaveLength(1);
  } finally { vi.restoreAllMocks(); await f.close(); }
});
test('simultaneous owner invocations retain their own Agent scope and leave no reusable authority after return', async () => {
  const f = await setup(); try {
    await Promise.all([f.invoke(), f.invoke({ ...f.input, clientEventId: 'other-owner-operation' }, f.context({ catId: 'other-cat', invocationId: 'other-invocation' }))]);
    const outbox = (await f.state()).connections[f.connection.connectionId].outbox;
    expect(outbox).toHaveLength(2); expect(outbox.map((x: { agent: unknown }) => x.agent)).toEqual(expect.arrayContaining([
      expect.objectContaining({ catId: 'codex-sol', sessionRef: 'owner-native-invocation' }), expect.objectContaining({ catId: 'other-cat', sessionRef: 'other-invocation' }),
    ]));
    await expect(f.invoke(f.input, null)).rejects.toMatchObject({ code: 'CONNECTOR_OWNER_AUTHORITY_REQUIRED' });
    expect(f.nativeReads).toBe(0);
  } finally { await f.close(); }
});


test('an asynchronous descendant cannot retain a completed owner Agent verification scope', async () => {
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  let late!: Promise<boolean>, nativeReads = 0;
  const verification = createCollectiveAgentVerification(() => {});
  const agent = { catId: 'cat', agentId: 'cat', displayName: 'Cat', sessionRef: 'invocation' };
  await verification.withOwner(agent, async () => {}, async () => {
    expect(await verification.verifyAgent(agent)).toBe(true);
    late = barrier.then(() => verification.verifyAgent(agent));
  });
  release(); expect(await late).toBe(false); expect(nativeReads).toBe(0);
});
