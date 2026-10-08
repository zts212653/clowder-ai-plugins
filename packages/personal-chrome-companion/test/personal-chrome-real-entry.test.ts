// Real-carrier entry test for the p2b module: the three cloud-conversation-host
// methods are real socket operations now. With no pairing record in the granted
// data directory they must honestly report the frozen (e) HOST_UNAVAILABLE /
// empty-list shapes through the real carrier, still passing the contract
// validators. Red history: on beta.8, start() threw FeaturePermissionError at
// plugin-entrypoint.ts `context.dataDirectory` (sol's R1, reproduced locally);
// before p2b the methods were placeholders returning the same shapes.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { acquireProcessLease } from '../native-host/native-socket-lease.mjs';
// @ts-expect-error The production native-host executable has no TypeScript declaration.
import { createNativeHostBridge } from '../native-host/native-host.mjs';
import { authorizePersonalChromeConversation } from '../native-host/conversation-binding.mjs';

import {
  isCloudConversationAckResult,
  isCloudConversationAppendMessageResult,
  isCloudConversationListResult,
  validateManifest,
  validateOperationRowsResult,
} from '@clowder-ai/plugin-contract';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';

import entrypoint, {
  PERSONAL_CHROME_APPEND_MESSAGE_METHOD,
  PERSONAL_CHROME_ASSISTANT_ACK_METHOD,
  PERSONAL_CHROME_ASSISTANT_LIST_METHOD,
  PERSONAL_CHROME_LIST_METHOD,
  PERSONAL_CHROME_REVOKE_METHOD,
  PERSONAL_CHROME_REFRESH_TITLES_METHOD,
  PERSONAL_CHROME_STATUS_METHOD,
  PERSONAL_CHROME_TEST_METHOD,
} from '../src/plugin-entrypoint.js';

const H3_METHODS = [
  PERSONAL_CHROME_APPEND_MESSAGE_METHOD,
  PERSONAL_CHROME_ASSISTANT_LIST_METHOD,
  PERSONAL_CHROME_ASSISTANT_ACK_METHOD,
] as const;

const H3_VALIDATORS = [
  isCloudConversationAppendMessageResult,
  isCloudConversationListResult,
  isCloudConversationAckResult,
] as const;

function loadManifest(): Parameters<typeof entrypoint.create>[0] {
  return parse(readFileSync(new URL('../plugin.yaml', import.meta.url), 'utf8')) as Parameters<
    typeof entrypoint.create
  >[0];
}

function makeHost(dataDirectory: string): ModulePluginHostShape {
  const task = {
    id: 'task-1', kind: 'work', threadId: 'thread-1', subjectKey: 'fixture:1', title: 'Fixture task',
    ownerCatId: null, status: 'todo', why: '', createdBy: 'system', createdAt: 1, updatedAt: 1,
  } as const;
  return {
    dataDirectory,
    config: { get: async (_key: string) => undefined },
    secrets: { get: async (_key: string) => undefined },
    storage: {
      get: async (_key: string) => undefined,
      list: async () => ({}),
      set: async (_key: string, _value: unknown) => ({ revision: 1 }),
      compareAndSet: async (_key: string, _expectedRevision: number | null, _value: unknown) =>
        ({ applied: true, revision: 1 }),
      delete: async (_key: string, _expectedRevision?: number) => ({ deleted: true, revision: 1 }),
    },
    tasks: {
      get: async () => task,
      listByThread: async () => [task],
      listByKind: async () => [task],
      getBySubject: async () => task,
      create: async () => task,
      upsertBySubject: async (_input: unknown) => task,
      update: async () => task,
      updateIfThreadId: async () => task,
    },
    threads: {
      get: async () => null,
      create: async () => ({ id: 'thread-1', title: 'Fixture', createdAt: 1, lastActiveAt: 1 }),
      update: async () => ({ id: 'thread-1', title: 'Fixture', createdAt: 1, lastActiveAt: 1 }),
      findByKey: async () => null,
      ensureByKey: async (_key: string, _input: unknown) =>
        ({ id: 'thread-1', title: 'Fixture', createdAt: 1, lastActiveAt: 1 }),
      bind: async () => ({ key: 'fixture', threadId: 'thread-1', createdAt: 1 }),
      unbind: async () => true,
      listBindings: async () => [],
      ensureSystemThread: async () => ({ id: 'system-thread', title: 'System', createdAt: 1, lastActiveAt: 1 }),
    },
    messaging: {
      send: async () => ({ messageId: 'message-1', threadId: 'thread-1' }),
      subscribe: async () => undefined,
      unsubscribe: async () => undefined,
    },
    media: {
      read: async (input: { readonly offset: number }) =>
        ({ offset: input.offset, dataBase64: '', done: true }),
    },
    log: (_level: string, _message: string, _fields?: Readonly<Record<string, unknown>>) => undefined,
  };
}

test('Settings selects rows from the real manifest and lists and revokes through its declared methods', async (t) => {
  const validated = validateManifest(loadManifest());
  assert.equal(validated.valid, true);
  if (!validated.valid) return;
  const operation = validated.manifest.configuration?.find((field) => field.key === 'personalChromeAuthorizations');
  assert.ok(operation?.kind === 'operation');
  // ActionRenderer selects the rows surface using this declaration, before any
  // method runs. A valid rows result alone cannot make the Settings UI reachable.
  const list = operation.actions.find((action) => action.resultRender === 'rows');
  assert.equal(list?.id, 'list', 'the manifest must select the generic Host rows renderer');
  assert.ok(list);
  const revoke = operation.actions.find((action) => action.id === 'revoke');
  const refresh = operation.actions.find((action) => action.id === 'refresh-titles');
  assert.equal(revoke?.render, 'row');
  assert.ok(revoke?.confirm);
  assert.equal(revoke.next, list.id);
  assert.equal(refresh?.render, 'button');
  assert.equal(refresh.next, list.id);
  const dataDirectory = await mkdtemp(join(tmpdir(), 'settings-rows-carrier-'));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  await authorizePersonalChromeConversation(join(dataDirectory, 'conversation-binding.json'), {
    conversationId: 'settings-conversation', chatUrl: 'https://chatgpt.com/c/settings-conversation',
    authorizedAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z',
  });
  const activation = await entrypoint.create(loadManifest()).start(makeHost(dataDirectory));
  try {
    const invoke = async (method: string, input: unknown) => {
      assert.equal(Object.hasOwn(activation.actions, method), true);
      return await activation.actions[method]!(input) as { render: string; data: unknown };
    };
    const listed = await invoke(list.action.method, {});
    assert.equal(listed.render, 'rows');
    const rows = validateOperationRowsResult(operation, listed.data);
    assert.equal(rows.valid, true, JSON.stringify(rows.errors));
    if (!rows.valid) return;
    assert.equal(rows.value.rows.length, 1);
    const row = rows.value.rows[0]!;
    assert.equal(row.key, 'settings-conversation');
    assert.deepEqual(row.actions, [{ action: revoke.id, input: { conversationId: row.key } }]);
    await invoke(revoke.action.method, row.actions![0]!.input);
    const after = validateOperationRowsResult(operation, (await invoke(list.action.method, {})).data);
    assert.equal(after.valid, true, JSON.stringify(after.errors));
    if (after.valid) assert.deepEqual(after.value.rows, []);
  } finally { await activation.stop(); }
});

test('real module entry starts across the SDK carrier and serves every p2b action', async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'p2a-real-entry-'));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));

  const logs: { level: string; message: string }[] = [];
  const host = makeHost(dataDirectory);
  const activation = await entrypoint.create(loadManifest()).start({
    ...host,
    log: (level, message) => { logs.push({ level, message }); },
  });
  const initialStatus = await activation.actions[PERSONAL_CHROME_STATUS_METHOD]!({}) as {
    label: string; data: { helper: { state: string } };
  };
  assert.equal(
    readFileSync(join(dataDirectory, 'extension', 'manifest.json'), 'utf8'),
    readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'),
    'start places unchanged extension bytes even before helper installation',
  );
  assert.equal(initialStatus.data.helper.state, 'unknown');
  assert.match(initialStatus.label, /Helper: unknown/);

  for (const method of [
    PERSONAL_CHROME_LIST_METHOD,
    PERSONAL_CHROME_REVOKE_METHOD,
    PERSONAL_CHROME_REFRESH_TITLES_METHOD,
    PERSONAL_CHROME_STATUS_METHOD,
    PERSONAL_CHROME_TEST_METHOD,
  ]) {
    assert.equal(Object.hasOwn(activation.actions, method), true, `actions owns ${method}`);
    assert.equal(typeof activation.actions[method], 'function', `actions ${method} is a function`);
  }

  // Host h3 enable preflight: the three cloud-conversation-host methods must be
  // own functions of the actions table and pass the contract validators through
  // the real carrier. Valid wire input with no pairing record in the granted
  // data directory must report the frozen (e) HOST_UNAVAILABLE / empty-list
  // shapes honestly (p2b makes them real socket operations).
  const h3Calls = [
    () => ({
      conversationId: 'conversation-1',
      text: 'hello from the test',
      idempotencyKey: 'delivery-1',
    }),
    () => ({}),
    () => ({
      conversationId: 'conversation-1',
      sourceMessageId: 'source-1',
      assistantMessageId: 'assistant-1',
    }),
  ];
  const expectedFrozenShapes = [
    { status: 'failed', errorCode: 'HOST_UNAVAILABLE' },
    { returns: [] },
    { status: 'failed', errorCode: 'HOST_UNAVAILABLE' },
  ] as const;
  for (let index = 0; index < H3_METHODS.length; index += 1) {
    const method = H3_METHODS[index]!;
    assert.equal(Object.hasOwn(activation.actions, method), true, `actions owns ${method}`);
    assert.equal(typeof activation.actions[method], 'function', `actions ${method} is a function`);
    const result = await activation.actions[method]!(h3Calls[index]!());
    assert.equal(
      H3_VALIDATORS[index]!(result),
      true,
      `${method} result passes the contract validator via real carrier`,
    );
    assert.deepEqual(result, expectedFrozenShapes[index], `${method} reports the frozen no-helper shape`);
  }

  const listed = await activation.actions[PERSONAL_CHROME_LIST_METHOD]!({});
  assert.ok(listed && typeof listed === 'object', 'list returns a result');
  const status = await activation.actions[PERSONAL_CHROME_STATUS_METHOD]!({});
  assert.ok(status && typeof status === 'object', 'status returns a result');
  assert.equal((status as { data: { helper: { state: string } } }).data.helper.state, 'not_installed');
  assert.match((status as { label: string }).label, /Settings.*Chrome connection/);
  assert.equal(logs.filter((log) => log.level === 'warn').length, 1, 'carrier forwards one state-change warning');
  // p2b makes `test` honest: the probe must actually attempt reachability and
  // report not-ok when no helper/pairing exists, never claiming reachability
  // without probing.
  const testResult = (await activation.actions[PERSONAL_CHROME_TEST_METHOD]!({})) as {
    ok?: boolean;
    message?: unknown;
  };
  assert.equal(testResult.ok, false, 'test action honestly reports unreachable');
  assert.equal(typeof testResult.message, 'string');
  assert.match(testResult.message as string, /Settings.*Chrome connection/);
  assert.doesNotMatch(testResult.message as string, /Reload the extension once/);
  assert.ok(
    typeof testResult.message === 'string' && testResult.message.length > 0,
    'test action explains the reason',
  );

  await activation.stop();
});

test('refresh action is an own function with validated titleSync and next-list sees refreshed rows', async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'p2e-carrier-'));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const require = createRequire(import.meta.url);
  const contractRequire = createRequire(import.meta.resolve('@clowder-ai/plugin-contract'));
  const Ajv = contractRequire('ajv/dist/2020');
  const ajv = new Ajv({ allErrors: true, strict: false });
  contractRequire('ajv-formats')(ajv);
  for (const name of ['plugin-metadata', 'signals', 'messaging', 'manifest']) {
    ajv.addSchema(JSON.parse(readFileSync(require.resolve(`@clowder-ai/plugin-contract/schemas/${name}`), 'utf8')));
  }
  const schema = JSON.parse(readFileSync(require.resolve('@clowder-ai/plugin-contract/schemas/manifest'), 'utf8'));
  const validate = ajv.getSchema(`${schema.$id}#/$defs/OperationActionResult`);
  const activation = await entrypoint.create(loadManifest()).start(makeHost(dataDirectory));
  try {
    assert.equal(Object.hasOwn(activation.actions, PERSONAL_CHROME_REFRESH_TITLES_METHOD), true);
    const refresh = activation.actions[PERSONAL_CHROME_REFRESH_TITLES_METHOD]!;
    assert.equal(typeof refresh, 'function');
    const absent = await refresh({});
    assert.equal(validate(absent), true, JSON.stringify(validate.errors));
    assert.deepEqual((absent as { data: unknown }).data, { titleSync: { status: 'unavailable', errorCode: 'HOST_UNAVAILABLE' } });
    const revision = `sha512:${'0'.repeat(128)}`;
    const socketPath = join(dataDirectory, 'host.sock');
    const ledgerPath = join(dataDirectory, 'ledger.json');
    const conversationBindingPath = join(dataDirectory, 'conversation-binding.json');
    const pairingSecret = 'a'.repeat(64);
    await writeFile(join(dataDirectory, 'pairing.json'), JSON.stringify({
      schemaVersion: 1, extensionId: 'a'.repeat(32), socketPath, ledgerPath, pairingSecret,
      artifactDigest: revision, installedAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z',
    }), { mode: 0o600 });
    await authorizePersonalChromeConversation(conversationBindingPath, {
      conversationId: 'one', chatUrl: 'https://chatgpt.com/c/one',
      authorizedAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z',
    });
    const bridge = await createNativeHostBridge({
      socketPath, ledgerPath, conversationBindingPath, pairingSecret, helperArtifactRevision: revision,
      sendNative: async (message: unknown) => {
        const request = message as { kind: string; requestId: string };
        if (request.kind === 'conversation_title_request') await bridge.acceptNativeMessage({
          v: 1, kind: 'conversation_title_result', requestId: request.requestId,
          titles: [{ conversationId: 'one', displayTitle: 'Readable recovery title' }],
        });
      },
    });
    try {
      const result = await refresh({});
      assert.equal(validate(result), true, JSON.stringify(validate.errors));
      assert.deepEqual((result as { data: unknown }).data, { titleSync: { status: 'synced', updatedCount: 1, requestedCount: 1 } });
      assert.match((result as { label: string }).label, /Updated 1 of 1/);
      const rows = await activation.actions[PERSONAL_CHROME_LIST_METHOD]!({}) as { data: { rows: { label: string }[] } };
      assert.equal(rows.data.rows[0]!.label, 'Readable recovery title');
      const status = await activation.actions[PERSONAL_CHROME_STATUS_METHOD]!({}) as { data: { delivery: { reloadRequired: boolean } } };
      assert.equal(status.data.delivery.reloadRequired, true, 'v1 refresh cannot certify extension revision');
    } finally { await bridge.stop(); }
  } finally { await activation.stop(); }
});

test('real start stays available when installer owns the lease and Status/Test explain the delivery failure', async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'p2d-real-entry-'));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const lease = await acquireProcessLease(join(dataDirectory, 'install'), { label: 'native host installation' });
  try {
    const activation = await entrypoint.create(loadManifest()).start(makeHost(dataDirectory));
    try {
      const status = await activation.actions[PERSONAL_CHROME_STATUS_METHOD]!({}) as { label: string; data: { delivery: { failure: string } } };
      assert.equal(status.data.delivery.failure, 'INSTALLATION_BUSY');
      assert.match(status.label, /INSTALLATION_BUSY/);
      const probe = await activation.actions[PERSONAL_CHROME_TEST_METHOD]!({}) as { ok: boolean; message: string };
      assert.equal(probe.ok, false);
      assert.match(probe.message, /INSTALLATION_BUSY/);
    } finally { await activation.stop(); }
  } finally { await lease.release(); }
});
