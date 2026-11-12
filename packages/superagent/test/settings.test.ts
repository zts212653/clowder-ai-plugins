import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateManifest, validateOperationRowsResult } from '@clowder-ai/plugin-contract';
import { z } from 'zod';
import { parse } from 'yaml';
import { startSuperagent } from '../src/runtime.js';
import { preferencesSchema } from '../src/state.js';
import { fixture } from './fixture.js';

test('assistant, execution members and watched conversations are separate settings that preserve each other', async () => {
  const declaration = validateManifest(
    parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')),
  );
  assert.ok(declaration.valid, JSON.stringify(declaration.errors));
  assert.ok(declaration.manifest.configuration);
  const operations = declaration.manifest.configuration.filter((field) => field.kind === 'operation');
  const fields = ['assistant', 'workers', 'scope'].map((key) => operations.find((field) => field.key === key));
  assert.ok(
    fields.every((field) => field !== undefined),
    'three independently configured selectors must be declared',
  );
  const f = fixture();
  await f.host.storage.set('preferences', {
    ...f.preferences,
    enabled: false,
    coordinatorId: undefined,
    workerIds: [],
    threadIds: [],
  });
  const runtime = await startSuperagent(f.host);
  const responseSchema = z.object({
    data: z.object({
      rows: z.array(
        z.object({
          key: z.string(),
          label: z.string(),
          actions: z.array(z.object({ action: z.string(), input: z.record(z.string(), z.unknown()) })).optional(),
        }),
      ),
    }),
  });
  const list = async (key: string) => {
    const field = operations.find((field) => field.key === key)!;
    const method = field.actions!.find((action) => action.id === 'list')!.action.method;
    const response = await runtime.actions[method]({});
    const result = responseSchema.parse(response);
    assert.equal(validateOperationRowsResult(field, z.object({ data: z.unknown() }).parse(response).data).valid, true);
    return result.data.rows;
  };
  const assistants = await list('assistant');
  assert.ok(assistants.some((row) => row.key === 'assistant-status' && !row.actions?.length));
  assert.ok(assistants.every((row) => row.key === 'assistant-status' || row.key.startsWith('coordinator:')));
  assert.ok((await list('workers')).every((row) => row.key.startsWith('worker:')));
  const scope = fields.find((field) => field?.key === 'scope')!;
  assert.equal(scope.actions![0].resultRender, 'thread-picker');
  const choose = async (field: string, selection: string, id: string) => {
    const response = await runtime.actions['superagent.choose'](
      { input: { botName: 'My assistant', selection, ...(selection === 'threads' ? { ids: [id] } : { id }) } },
      undefined,
      {
        kind: 'owner-operation',
        userId: 'owner',
        pluginInstanceId: f.host.pluginInstanceId,
        operationKey: field,
        actionId: 'choose',
        requestId: `${selection}-${id}`,
        signal: new AbortController().signal,
        assertCurrent: async () => {},
      },
    );
    if (selection === 'threads') {
      assert.deepEqual(z.object({ data: z.object({ selected: z.array(z.string()) }) }).parse(response).data.selected, [id]);
      return [];
    }
    const rows = responseSchema.parse(response).data.rows;
    const declared = operations.find((item) => item.key === field)!;
    assert.equal(
      validateOperationRowsResult(declared, z.object({ data: z.unknown() }).parse(response).data).valid,
      true,
    );
    return rows;
  };
  const assistant = await choose('assistant', 'coordinator', 'coordinator');
  assert.ok(assistant.every((row) => row.key.startsWith('coordinator:')));
  assert.equal(
    assistant.find((row) => row.key === 'coordinator:coordinator')!.actions?.length ?? 0,
    0,
    'the current assistant is a selection, not another choose button',
  );
  const workers = await choose('workers', 'worker', 'coordinator');
  assert.ok(workers.every((row) => row.key.startsWith('worker:')));
  await choose('workers', 'worker', 'worker');
  await choose('scope', 'threads', 'source-a');
  await choose('assistant', 'coordinator', 'worker');
  await choose('workers', 'worker', 'worker');
  const saved = preferencesSchema.parse((await f.host.storage.get('preferences'))?.value);
  assert.equal(saved.coordinatorId, 'worker', 'assistant selection replaces only the single assistant');
  assert.deepEqual(
    saved.workerIds,
    ['coordinator'],
    'execution selection supports multiple members, including the assistant',
  );
  assert.deepEqual(saved.threadIds, ['source-a']);
  assert.equal(f.subscriptions.has('source-a'), false, 'selection alone does not start watching the chosen source');
  assert.equal(
    [...f.sent.values()].filter((message) => message.wake).length,
    0,
    'opening or changing selectors does not invoke members',
  );
  await runtime.stop({ reason: 'test' });
});

test('empty directories explain how to configure members and do not read conversations for member selection', async () => {
  const f = fixture();
  await f.host.storage.set('preferences', {
    ...f.preferences,
    enabled: false,
    coordinatorId: undefined,
    workerIds: [],
    threadIds: [],
  });
  f.host.members!.list = async () => [];
  let directoryReads = 0;
  f.host.threads.list = async () => {
    directoryReads++;
    return [];
  };
  const runtime = await startSuperagent(f.host);
  const rowsSchema = z.object({ data: z.object({ rows: z.array(z.unknown()), empty: z.string() }) });
  for (const method of ['superagent.assistant', 'superagent.workers']) {
    const result = rowsSchema.parse(await runtime.actions[method]({})).data;
    assert.deepEqual(result.rows, []);
    assert.match(result.empty, /猫猫团队/);
  }
  assert.equal(directoryReads, 0);
  const conversations = z.object({ render: z.literal('thread-picker'), data: z.object({ selected: z.array(z.string()) }) })
    .parse(await runtime.actions['superagent.settings']({})).data;
  assert.deepEqual(conversations.selected, []);
  assert.equal(directoryReads, 0, 'the Host supplies its own native conversation picker');
  await runtime.stop({ reason: 'test' });
});
