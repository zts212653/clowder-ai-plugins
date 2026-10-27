import { join } from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { openCollectiveContextReferences } from '../../../collective-context-refs.js';
import { createCollectivePublicNativeActions } from '../../../collective-public-native-context.js';
import { publicSourceFixture } from './public-source-caller.fixture.js';

it('delivers a rich-only source with a readable inspection cue and gives the named native consumer the original public content', async () => {
  const f = await publicSourceFixture();
  try {
    const richBlocks = [{ v: 1, id: 'public-visual', kind: 'html_widget', title: '一起看的内容', html: '<p>原始公开内容 original public content</p>' }];
    const source = await f.store.postHumanMessage(f.serviceOwner.sessionToken, {
      serviceInstanceId: f.connection.serviceInstanceId, collectiveId: f.connection.collectiveId,
      clientEventId: 'rich-only-native-source', body: '', richBlocks, location: { channelId: 'general' },
      recipient: { kind: 'agent', humanId: f.serviceOwner.human.humanId, connectionId: f.source.connectionId,
        agentId: f.source.catId, participationRevision: f.source.participationRevision },
    });
    await f.connector.sync(f.connection.connectionId);
    await f.sourceCaller.admitAgentEvent(f.connection.connectionId, source.eventId, f.owner);
    expect(f.native.source.content).toContain('html_widget');
    expect(f.native.source.content).toContain(source.eventId);
    expect(f.native.source.content).toContain('cat_cafe_collective_read_context');
    const references = await openCollectiveContextReferences(join(f.root, 'native-rich-refs'), () => {});
    const actions = createCollectivePublicNativeActions({ connector: f.connector, sourceCaller: f.sourceCaller, references });
    const current = z.object({ contextRef: z.string() }).passthrough().parse(await actions['collective.context.current']!({}, f.action));
    const result = await actions['collective.context.read']!({ contextRef: current.contextRef }, f.action);
    expect(JSON.stringify(result)).toContain('原始公开内容 original public content');
    expect(JSON.stringify(result)).toContain('public-visual');
  } finally { await f.close(); }
});

it('publishes a named cat rich-only reply through the original native operation and preserves its exact retry payload', async () => {
  const f = await publicSourceFixture({ invocationId: 'fixture-running-turn' });
  try {
    await f.admit();
    const references = await openCollectiveContextReferences(join(f.root, 'native-rich-reply-refs'), () => {});
    const actions = createCollectivePublicNativeActions({ connector: f.connector, sourceCaller: f.sourceCaller, references });
    const current = z.object({ returnRef: z.string(), replyOperationRef: z.string() }).passthrough()
      .parse(await actions['collective.context.current']!({}, f.action));
    const richBlocks = [{ v: 1, id: 'named-checklist', kind: 'checklist', title: '一起看原文',
      items: [{ id: 'read', text: '原文已读', checked: true }] }];
    const input = { returnRef: current.returnRef, replyOperationRef: current.replyOperationRef, body: '', richBlocks };
    const first = await actions['collective.reply.submit']!(input, f.action);
    const second = await actions['collective.reply.submit']!(input, f.action);
    expect(first).toMatchObject({ reply: { status: 'accepted', richBlocks } });
    expect(second).toMatchObject(first as object);
    const events = await f.store.listEventsForHuman(f.serviceOwner.sessionToken, f.connection.collectiveId);
    const replies = events.filter(event => event.actor.kind === 'agent' && event.replyToEventId === f.source.eventId);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ body: '', richBlocks, actor: { kind: 'agent', agent: { agentId: f.action.catId } } });
    await expect(actions['collective.reply.submit']!({ ...input, richBlocks: [{ ...richBlocks[0], title: 'different payload' }] }, f.action))
      .rejects.toMatchObject({ code: 'REPLY_PAYLOAD_CONFLICT' });
    await f.store.revokeConnection({ sessionToken: f.serviceOwner.sessionToken, collectiveId: f.connection.collectiveId,
      connectionId: f.connection.connectionId });
    await expect(actions['collective.reply.submit']!(input, f.action)).rejects.toBeDefined();
  } finally { await f.close(); }
});
