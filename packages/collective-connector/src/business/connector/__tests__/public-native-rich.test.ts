import { join } from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { openCollectiveContextReferences } from '../../../collective-context-refs.js';
import { createCollectivePublicNativeActions } from '../../../collective-public-native-context.js';
import { publicSourceFixture } from './public-source-caller.fixture.js';

it('delivers a rich-only source with a readable inspection cue and gives the named native consumer the original public content', async () => {
  const f = await publicSourceFixture({ methods: ['collective.context.current', 'collective.context.read'] });
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
