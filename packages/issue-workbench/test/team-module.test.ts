import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import { createIssueTeamModule } from '../src/team/plugin-entrypoint.js';
import type { SharedReceipt } from '../src/team/types.js';
import { setup } from './helpers/team-fixture.js';

const manifest = parse(readFileSync(new URL('../plugin.yaml', import.meta.url), 'utf8'));
function moduleHost(s: ReturnType<typeof setup>): ModulePluginHostShape {
  return { ...s.context, dataPath: '/isolated-fixture', secrets: { get: async () => undefined }, tasks: {} as any, streams: {} as any,
    messaging: { ...s.context.messaging, send: ({ threadId, ...draft }) => s.context.messaging.send(threadId, draft) } } as ModulePluginHostShape;
}
test('SDK module journey: two isolated Host stores, offline assignment, startup inbox and authored report return', async () => {
  const sender = setup(), receiver = setup();
  sender.issues[0].author = 'alice';
  sender.config.automaticAssignment = false;
  receiver.config.automaticAssignment = false; receiver.config.shareProgress = true;
  const receipts: SharedReceipt[] = [];
  sender.provider.receipts = async () => receipts;
  receiver.provider = { ...sender.provider, identity: async () => 'alice',
    publishReceipt: async (_issue, receipt) => { receipts.push(receipt); return 'shared-receipt'; } };
  const a = await createIssueTeamModule(sender.provider).create(manifest).start(moduleHost(sender));
  const job = (await a.actions['issue.team.analyze']!({ repo: 'fixture/repo', number: 1, requestId: 'module-1' }, sender.caller('requester')) as any).data;
  sender.config.automaticAssignment = true;
  await a.actions['issue.team.submit']!({ id: job.id, analysis: sender.analysis }, sender.caller());
  assert.deepEqual(sender.writes, ['alice']);
  assert.equal(receiver.sends.size, 0, 'receiver has not started');
  const b = await createIssueTeamModule(receiver.provider).create(manifest).start(moduleHost(receiver));
  assert.equal(receiver.sends.size, 1, 'first startup includes already-assigned issues');
  const notice = [...receiver.sends.values()][0];
  assert.equal(notice.threadId, 'inbox');
  assert.equal(notice.draft.wake.catId, 'receiver', 'the member Host selects its own configured cat');
  assert.match(notice.draft.payload.elements[0].payload.text, /alice.*验收|验收.*alice/);
  const inbox = (await b.actions['issue.team.receive']!({}, receiver.caller('receiver', 'inbox')) as any).data;
  assert.equal(inbox[0].score, 9);
  await b.actions['issue.team.report']!({ id: inbox[0].id, status: 'accepted', summary: 'Confirmed receipt', evidenceUrls: [] }, receiver.caller('receiver', 'inbox'));
  const readback = (await a.actions['issue.team.get']!({ id: job.id }, sender.caller()) as any).data;
  assert.equal(readback.sharedReceipts[0].login, 'alice');
  assert.equal(readback.sharedReceipts[0].status, 'accepted');
  await b.stop();
  const restarted = await createIssueTeamModule(receiver.provider).create(manifest).start(moduleHost(receiver));
  assert.equal(receiver.sends.size, 1, 'restart does not duplicate the inbox message');
  await assert.rejects(restarted.actions['issue.team.submit']!({ id: job.id, analysis: sender.analysis }) as Promise<unknown>, /Host caller/);
  await Promise.all([a.stop(), restarted.stop()]);
});
