import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './communication-work-custody.fixture.js';
import type { PluginActionContext, PluginMessage, PluginOwnerOperationContext, FeatureContext } from '@clowder-ai/plugin-sdk';
import type { CollectiveMessageAttachmentOwnerPort } from '../../contracts/message-attachment-owner.js';

type PluginSourceFact = Omit<Partial<PluginMessage>,'extra'> & {extra?:unknown};
type DeliveredCallFixture = Omit<PluginActionContext,'source'> & {originTriggerMessageId:string;source:PluginMessage & {source:NonNullable<PluginMessage['source']>}};
export async function publicSourceFixture(options: { invocationId?: string; messageAttachmentOwner?: CollectiveMessageAttachmentOwnerPort } = {}) {
  const module = await import(process.env.PUBLIC_SOURCE_ROUTING_COMPILED === '1'
    ? '../../../../dist/collective-public-source.js' : '../../../collective-public-source.js');
  const f = await fixture({ messageAttachmentOwner: options.messageAttachmentOwner }); await f.connector.sync(f.connection.connectionId);
  const calls: unknown[] = []; let expired = false, native: DeliveredCallFixture;
  let beforeThread: (() => Promise<void>) | undefined;
  let beforeSendReturns: (() => Promise<void>) | undefined, loseSend = false;
  let publishedThread: string | undefined;
  const current = async () => { if (expired) throw new Error('Caller expired'); };
  const owner: PluginOwnerOperationContext = { kind: 'owner-operation', userId: 'local-owner', pluginInstanceId: 'installed-instance',
    operationKey: 'sync', actionId: 'sync', requestId: 'request', signal: new AbortController().signal, assertCurrent: current };
  const ports: Parameters<typeof import('../../../collective-public-source.js').createCollectivePublicSourceCaller>[0] = { connector: f.connector,
    native: { contributionId: 'collective-native' },
    pluginInstanceId: owner.pluginInstanceId,
    threads: { async get(id: string) { calls.push(['thread', id]); await beforeThread?.(); return { id } as never; },
      async getCats() { return { participants: [{ catId: 'codex-sol' }] } as never; } },
    messaging: { async subscribe() { throw new Error('Unused'); }, async unsubscribe() { throw new Error('Unused'); },
      async get(id: string) {return id !== 'host-source' || !native ? null : {...native.source, mentions: [], timestamp: 0, sourceRevision: 'fixture-owned-message',
        source: {...native.source.source}, extra: undefined};},
      async send(threadId: string, draft: Parameters<FeatureContext['messaging']['send']>[1]) { calls.push(['send', threadId, draft]);
      // The real Host ledger keeps its first thread for this instance/key.
      const settledThread = publishedThread ?? threadId;
      publishedThread = settledThread;
      native = { userId: owner.userId, threadId: settledThread, catId: 'codex-sol', invocationId: options.invocationId ?? 'native-invocation', originTriggerMessageId: 'host-source', assertCurrent: current,
        source: { id: 'host-source', mentions: [], timestamp: 0, sourceRevision: 'source', userId: owner.userId, threadId: settledThread, catId: null, content: (draft.payload.elements[0]!.payload as { text: string }).text, source: { connector: 'collective', label: 'Collective', icon: 'collective', meta: draft.meta },
 } };
      await beforeSendReturns?.();
      if (loseSend) throw new Error('Wake send response lost');
      return { messageId: 'host-source', threadId: settledThread, revision: 1,
        messageHandle: { kind: 'message' as const, token: 'fixture-host-message-handle' }, publishSequence: 42 }; } },
  };
  const sourceCaller = module.createCollectivePublicSourceCaller(ports);
  const admit = () => sourceCaller.admitAgentEvent(f.connection.connectionId, f.source.eventId, owner);
  const action: PluginActionContext = { userId: owner.userId, threadId: 'channel', catId: 'codex-sol', invocationId: options.invocationId ?? 'native-invocation', originTriggerMessageId: 'host-source', assertCurrent: current };
  return { ...f, serviceOwner: f.owner, owner, calls, ports: {pluginInstanceId:ports.pluginInstanceId,messaging:ports.messaging,threads:ports.threads,native:ports.native}, sourceCaller, admit, action, get native() { return native; }, beforeThread(fn: () => Promise<void>) { beforeThread = fn; }, beforeSendReturns(fn: () => Promise<void>) { beforeSendReturns = fn; }, loseSend() { loseSend = true; }, recoverSend() { loseSend = false; }, updateFact(source: Partial<PluginSourceFact>) { native = { ...native, source: { ...native.source, ...source } as DeliveredCallFixture['source'] }; }, expire() { expired = true; } };
}
