import { expect, it } from 'vitest';
import { publicSourceFixture as setup } from './public-source-caller.fixture.js';
import { createCollectivePublicNativeActions } from '../../../collective-public-native-context.js';
import { openCollectiveContextReferences } from '../../../collective-context-refs.js';
import { join } from 'node:path';

it('sends once with named wake and resolves the authenticated native origin before send returns', async () => {
  const f = await setup(); try {
    let early: unknown;
    f.beforeSendReturns(async () => {
      early = await f.sourceCaller.resolveNative(f.action);
    });
    const receipt = await f.admit();
    expect(receipt).toEqual({ messageId: 'host-source', threadId: 'channel' });
    expect(early).toMatchObject({ source: f.source, sourceRef: 'message:host-source' });
    expect(f.calls.map((call: any) => call[0])).toEqual(['thread', 'send']);
    expect((f.calls[1] as any)[2].wake).toEqual({ catId: f.source.catId });
    expect((await f.connector.listInbox(f.connection.connectionId))[0]).toMatchObject({ disposition: 'routed' });
  } finally { await f.close(); }
});

it('runs all four original native consumers while Host send is still awaiting its wake receipt', async () => {
  const f = await setup({ invocationId: 'fixture-running-turn' }); try {
    const references = await openCollectiveContextReferences(join(f.root, 'early-native-refs'), () => {});
    const actions = createCollectivePublicNativeActions({ connector: f.connector, sourceCaller: f.sourceCaller, references });
    f.beforeSendReturns(async () => {
      const invoke = (method: string, input: unknown) => Promise.resolve(actions[method]!(input, f.action)) as Promise<any>;
      const context = await invoke('collective.context.current', {});
      expect(context.request).toEqual((await f.connector.readParticipationContext(f.source, 0, 1)).source);
      await invoke('collective.context.read', { contextRef: context.contextRef });
      await invoke('collective.participation.set-interest', { contextRef: context.contextRef, state: 'listen' });
      const reply = await invoke('collective.reply.submit', { returnRef: context.returnRef,
        replyOperationRef: context.replyOperationRef, body: 'Original reply during the wake' });
      expect(reply.reply.status).toBe('accepted');
    });
    await f.admit();
    expect(f.calls.filter((call: any) => call[0] === 'enqueue')).toHaveLength(0);
  } finally { await f.close(); }
});

it('retries the same Host send after a lost wake receipt even if native has already persisted the source mapping', async () => {
  const f = await setup(); try {
    f.beforeSendReturns(async () => { await f.sourceCaller.resolveNative(f.action); });
    f.loseSend(); await expect(f.admit()).rejects.toThrow('Wake send response lost');
    const binding = f.connector.readCurrentPublicSource('message:host-source');
    f.recoverSend(); await f.admit();
    expect(f.connector.readCurrentPublicSource('message:host-source')).toEqual(binding);
    const sends = f.calls.filter((call: any) => call[0] === 'send') as any[];
    expect(sends).toHaveLength(2);
    expect(sends[0][2]).toEqual(sends[1][2]);
    expect(f.calls.filter((call: any) => call[0] === 'enqueue')).toHaveLength(0);
    await f.admit();
    expect(f.calls.filter((call: any) => call[0] === 'send')).toHaveLength(2);
  } finally { await f.close(); }
});
