import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateOperationRowsResult } from '@clowder-ai/plugin-contract';
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
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  const operation = manifest.configuration.find((field: { key: string }) => field.key === 'scope');
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
  const firstResponse = await runtime.actions['superagent.settings']({});
  const firstResult = z.object({ data: z.unknown() }).parse(firstResponse);
  const firstValidation = validateOperationRowsResult(operation, firstResult.data);
  assert.equal(firstValidation.valid, true, JSON.stringify(firstValidation));
  const first = rowsSchema.parse(firstResponse).data.rows;
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
  await runtime.actions['superagent.page'](
    { input: { botName: 'My assistant', responsibility: 'Selected work', ...more.actions[0].input } },
    undefined,
    owner,
  );
  const nextResponse = await runtime.actions['superagent.settings']({});
  const nextResult = z.object({ data: z.unknown() }).parse(nextResponse);
  const nextValidation = validateOperationRowsResult(operation, nextResult.data);
  assert.equal(nextValidation.valid, true, JSON.stringify(nextValidation));
  const next = rowsSchema.parse(nextResponse).data.rows;
  assert.ok(next.some((row) => row.key === 'older'));
  assert.ok(next.some((row) => row.key === 'source-a'));
  const recent = next.find((row) => row.key === 'recent')!;
  await runtime.actions['superagent.page'](
    { input: { botName: 'My assistant', responsibility: 'Selected work', ...recent.actions[0].input } },
    undefined,
    owner,
  );
  const returnedResponse = await runtime.actions['superagent.settings']({});
  const returned = z.object({ data: z.unknown() }).parse(returnedResponse);
  assert.equal(validateOperationRowsResult(operation, returned.data).valid, true);
  assert.ok(rowsSchema.parse(returnedResponse).data.rows.some((row) => row.key === 'more'));
  await runtime.stop({ reason: 'test' });
  await assert.rejects(async () => runtime.actions['superagent.settings']({}), /stopped/);
});
