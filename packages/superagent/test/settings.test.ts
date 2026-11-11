import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { startSuperagent } from '../src/runtime.js';
import { fixture } from './fixture.js';

test('setup does not subscribe before confirmation; older selected conversations remain removable across directory pages', async () => {
  const f = fixture();
  await f.host.storage.set('preferences', { ...f.preferences, enabled: false });
  const source = f.threads.get('source-a')!;
  const page = Array.from({ length: 50 }, (_, index) => ({
    ...source,
    id: `recent-${index}`,
    lastActiveAt: 100 - index,
  }));
  f.host.threads.list = async (input) => (input?.before ? [{ ...source, id: 'older' }] : page);
  const runtime = await startSuperagent(f.host);
  assert.equal(f.subscriptions.has('source-a'), false);
  const rowsSchema = z.object({
    data: z.object({
      rows: z.array(
        z.object({
          key: z.string(),
          actions: z.array(
            z.object({
              action: z.string(),
              input: z.record(z.string(), z.unknown()),
            }),
          ),
        }),
      ),
    }),
  });
  const first = rowsSchema.parse(await runtime.actions['superagent.settings']({})).data.rows;
  assert.ok(first.some((row) => row.key === 'source-a' && row.actions[0].action === 'choose'));
  const more = first.find((row) => row.key === 'more')!;
  const owner = {
    kind: 'owner-operation' as const,
    userId: 'owner',
    pluginInstanceId: f.host.pluginInstanceId,
    operationKey: 'scope',
    actionId: 'page',
    requestId: 'request-page',
    signal: new AbortController().signal,
    assertCurrent: async () => {},
  };
  await runtime.actions['superagent.page']({ input: more.actions[0].input }, undefined, owner);
  const next = rowsSchema.parse(await runtime.actions['superagent.settings']({})).data.rows;
  assert.ok(next.some((row) => row.key === 'older'));
  assert.ok(next.some((row) => row.key === 'source-a'));
  await runtime.stop({ reason: 'test' });
  await assert.rejects(async () => runtime.actions['superagent.settings']({}), /stopped/);
});
