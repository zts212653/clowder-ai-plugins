import {memoryStorage, serviceHostConfig, ownerAction} from '../../../../test/runtime-fixture.js';
import { expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { ModulePluginHostShape, PluginMessage, PluginOwnerOperationContext } from '@clowder-ai/plugin-sdk';
import entrypoint from '../../../plugin-entrypoint.js';
import { fixture } from './communication-work-custody.fixture.js';

const manifest = parse(await readFile(new URL('../../../../plugin.yaml', import.meta.url), 'utf8'));
test('actual module sends one named wake and handles native context before the send receipt', async () => {
  const f = await fixture();
  await f.connector.adoptWorkPolicy(f.connection.connectionId, 'local-owner', f.policy.revision);
  let source: PluginMessage;
  const calls: string[] = [];
  const current = async () => {};
  const owner: PluginOwnerOperationContext = { kind: 'owner-operation', userId: 'local-owner', pluginInstanceId: 'installed-instance',
    operationKey: 'participation', actionId: 'sync', requestId: 'owner-sync', signal: new AbortController().signal, assertCurrent: current };
  const host: ModulePluginHostShape = {
    pluginInstanceId: 'installed-instance',
    dataPath: f.root, config: serviceHostConfig(), secrets: { async get() { return undefined; } },
    storage: memoryStorage(), tasks: {list: async () => []} as never, streams: {} as never, log() {},
    members: { async get() { return null; }, async list() { return [{ catId: 'codex-sol', displayName: 'Sol', defaultModel: 'fixture', available: true }]; } },
    threads: { async get(id: string) { return { id } as never; }, async getCats() { return { participants: [{ catId: 'codex-sol' }] } as never; },
      async create() { throw new Error('Unused'); }, async addParticipants() { throw new Error('Unused'); }, async list(){return [];}, async readMessages(){return [];}, async update(){throw new Error('Unused');} },

    messaging: { async get(id) {return source?.id===id?source:null;}, async subscribe() {}, async unsubscribe() {}, async send(draft) {
      const threadId = draft.threadId;
      calls.push('send');
      expect(draft.wake).toEqual({ catId: 'codex-sol' });
      source = { id: 'message-origin', userId: owner.userId, threadId, catId: null,
        mentions: [], timestamp: 1, sourceRevision: '1', content: (draft.payload.elements[0]!.payload as {text:string}).text,
        source: {connector:'collective',label:'Collective',icon:'collective',meta:draft.meta} };
      const action = { userId: owner.userId, threadId, catId: 'codex-sol', invocationId: 'real-native', originTriggerMessageId: 'message-origin', assertCurrent: current };
      const early = await active!.actions['collective.context.current']!({}, action);
      expect(early).toHaveProperty('contextRef');
      const proposed = await active!.actions['collective.work.propose']!({ contextRef: (early as { contextRef: string }).contextRef, title: 'Original public proposal' }, action);
      expect(proposed).toMatchObject({ status: 'proposed' });
      const accepted = await active!.actions['collective.work.accept']!({ contextRef: (early as { contextRef: string }).contextRef, ...f.input }, action);
      expect(accepted).toMatchObject({ disposition: 'accepted_pending_host_admission', lifecycle: 'committed' });
      const after = await active!.actions['collective.context.current']!({}, action) as { contextRef: string; workSourceContext: { matters: { workRef: string }[] } };
      const continued = await active!.actions['collective.work.continue']!({ contextRef: after.contextRef,
        workRef: after.workSourceContext.matters[0]!.workRef, kind: 'resume', grantRef: f.input.grantRef,
        grantRevision: f.input.grantRevision, requestKind: f.input.requestKind }, action);
      expect(continued).toMatchObject({ disposition: 'accepted_pending_host_admission', executionAuthority: { revision: 2 } });
      calls.push('native-before-receipt');
      return { messageId: 'message-origin', threadId, revision: 1,
        messageHandle: { kind: 'message' as const, token: 'fixture-host-message-handle' }, publishSequence: 42 };
    } },

  };
  let active: Awaited<ReturnType<ReturnType<typeof entrypoint.create>['start']>> | undefined;
  try {
    expect(manifest.contributions.find((item: { type: string; id: string }) => item.type === 'mcp' && item.id === 'collective-native')).toBeDefined();
    const declared = manifest.contributions.find((item: { id: string }) => item.id === 'collective-native');
    expect(declared.actions).toContainEqual({ method: 'collective.work.propose' });
    expect(declared.actions).toContainEqual({ method: 'collective.work.accept' });
    expect(declared.actions).toContainEqual({ method: 'collective.work.continue' });
    active = await entrypoint.create(manifest).start(host);
    expect(Object.hasOwn(active, 'publicInvocationVerifier')).toBe(false);
    const roster = await ownerAction(active.actions['collective.control.http']!, owner.userId)({ request: { method: 'GET', path: 'entry-roster',
      headers: { origin: 'http://localhost:5172' }, principal: { kind: 'owner', id: owner.userId } } });
    expect(roster).toMatchObject({ status: 200, body: { cats: [{ id: 'codex-sol', eligible: true }] } });
    await expect(active.actions['collective.owner.connections']!({}, undefined, { ...owner, actionId: 'list' })).rejects.toThrow();
    await expect(active.actions['collective.owner.connections']!({ input: { userId: owner.userId } }, undefined, { ...owner, actionId: 'list' })).rejects.toThrow();
    await expect(active.actions['collective.owner.connections']!({ input: {} }, undefined, { ...owner, actionId: 'list' })).resolves.toMatchObject({ render: 'rows', data: { rows: [{ actions: [{ input: { connectionId: f.connection.connectionId } }] }] } });
    await expect(active.actions['collective.owner.sync']!({ input: { connectionId: f.connection.connectionId } })).rejects.toThrow();
    const admitted = await active.actions['collective.owner.sync']!({ input: { connectionId: f.connection.connectionId } }, undefined, owner);
    expect(admitted).toMatchObject({ render: 'rows', data: { rows: [{ key: f.source.eventId, detail: expect.stringContaining('message-origin') }] } });
    expect(calls).toEqual(['send', 'native-before-receipt']);
    const action = { userId: owner.userId, threadId: 'channel', catId: 'codex-sol', invocationId: 'real-native', originTriggerMessageId: 'message-origin', assertCurrent: current };
    const result = await active.actions['collective.context.current']!({}, action) as { contextRef: string; returnRef: string; replyOperationRef: string };
    const binding = JSON.parse(await readFile(join(f.root, 'connector/collective-connector.json'), 'utf8'));
    expect(JSON.stringify(binding)).toContain('message:message-origin');
    await expect(active.actions['collective.reply.submit']!({ returnRef: result.returnRef, replyOperationRef: result.replyOperationRef, body: 'Original reply' }, action))
      .resolves.toMatchObject({ reply: { status: 'accepted', body: 'Original reply', author: { sessionRef: 'real-native' } } });
    await active.stop({reason:'test'});
    await expect(active.actions['collective.context.current']!({}, action)).rejects.toThrow(/revoked|stopped/);
  } finally { await active?.stop({reason:'test'}); await f.close(); }
});
