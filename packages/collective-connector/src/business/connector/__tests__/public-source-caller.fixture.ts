import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './communication-work-custody.fixture.js';
import type { PluginActionContext, PluginNativeContext, PluginSourceFact, PluginOwnerOperationContext, FeatureContext } from '@clowder-ai/plugin-sdk';

export async function publicSourceFixture(options: { methods?: readonly string[]; invocationId?: string } = {}) {
  const module = await import(process.env.PUBLIC_SOURCE_ROUTING_COMPILED === '1'
    ? '../../../../dist/collective-public-source.js' : '../../../collective-public-source.js');
  const f = await fixture(); await f.connector.sync(f.connection.connectionId);
  const calls: unknown[] = []; let expired = false, native: PluginNativeContext;
  let beforeThread: (() => Promise<void>) | undefined;
  let beforeSendReturns: (() => Promise<void>) | undefined, loseSend = false;
  let publishedThread: string | undefined;
  const current = async () => { if (expired) throw new Error('Caller expired'); };
  const owner: PluginOwnerOperationContext = { kind: 'owner-operation', userId: 'local-owner', pluginInstanceId: 'installed-instance',
    operationKey: 'sync', actionId: 'sync', requestId: 'request', signal: new AbortController().signal, assertCurrent: current };
  const sourceCaller = module.createCollectivePublicSourceCaller({ connector: f.connector,
    native: { contributionId: 'collective-native', methods: options.methods ?? ['collective.reply.submit', 'collective.context.current'] },
    ownerThreads: { async get(id: string) { calls.push(['thread', id]); await beforeThread?.(); return { id, createdBy: owner.userId, participants: ['codex-sol'] }; },
      async create() { throw new Error('Unused'); }, async addParticipants() { throw new Error('Unused'); } },
    messaging: { async subscribe() { throw new Error('Unused'); }, async unsubscribe() { throw new Error('Unused'); },
      async get(id: string) {return id !== 'host-source' || !native ? null : {...native.source, mentions: [], timestamp: 0, sourceRevision: 'fixture-owned-message',
        source: {label: 'Collective', icon: 'collective', ...native.source.source}, extra: undefined};},
      async send(threadId: string, draft: Parameters<FeatureContext['messaging']['send']>[1]) { calls.push(['send', threadId, draft]);
      // The real Host ledger keeps its first thread for this instance/key.
      const settledThread = publishedThread ?? threadId;
      publishedThread = settledThread;
      native = { userId: owner.userId, threadId: settledThread, catId: 'codex-sol', invocationId: options.invocationId ?? 'native-invocation', originTriggerMessageId: 'host-source',
        source: { id: 'host-source', userId: owner.userId, threadId: settledThread, catId: null, content: (draft.payload.elements[0]!.payload as { text: string }).text, source: { connector: 'collective', meta: draft.meta },
          extra: { pluginMessage: { instanceId: owner.pluginInstanceId } } } };
      await beforeSendReturns?.();
      if (loseSend) throw new Error('Wake send response lost');
      return { messageId: 'host-source', threadId: settledThread, revision: 1,
        messageHandle: { kind: 'message' as const, token: 'fixture-host-message-handle' }, publishSequence: 42 }; } },
    nativeContext: { async current() { return structuredClone(native); } },
  });
  const admit = () => sourceCaller.admitAgentEvent(f.connection.connectionId, f.source.eventId, owner);
  const action: PluginActionContext = { userId: owner.userId, threadId: 'channel', catId: 'codex-sol', invocationId: options.invocationId ?? 'native-invocation', assertCurrent: current };
  return { ...f, serviceOwner: f.owner, owner, calls, sourceCaller, admit, action, get native() { return native; }, beforeThread(fn: () => Promise<void>) { beforeThread = fn; }, beforeSendReturns(fn: () => Promise<void>) { beforeSendReturns = fn; }, loseSend() { loseSend = true; }, recoverSend() { loseSend = false; }, updateFact(source: Partial<PluginSourceFact>) { native = { ...native, source: { ...native.source, ...source } }; }, expire() { expired = true; } };
}
