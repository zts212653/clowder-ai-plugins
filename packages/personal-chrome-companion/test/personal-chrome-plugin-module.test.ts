import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  validateOperationRowsResult,
  type ActionDef,
  type OperationRows,
} from '@clowder-ai/plugin-contract';
import {
  createFeatureContextSession,
  FeaturePermissionError,
  type FeatureBinding,
  type FeatureHostAdapter,
} from '@clowder-ai/plugin-sdk';

import {
  createAuthorizationOperations,
  buildAuthorizationRows,
} from '../src/plugin-entrypoint.js';
import {
  PERSONAL_CHROME_AUTHORIZATION_LIMIT,
  authorizePersonalChromeConversation,
  isPersonalChromeConversationId,
  readPersonalChromeConversationAuthorizations,
} from '../native-host/conversation-binding.mjs';
import { writeConversationTitles } from '../native-host/conversation-titles.mjs';

const ROW_OPERATION_ACTIONS: readonly ActionDef[] = [
  { id: 'list', label: 'Authorized conversations', render: 'status', action: { method: 'm.list' } },
  {
    id: 'revoke',
    label: 'Revoke authorization',
    render: 'row',
    action: { method: 'm.revoke' },
    next: 'list',
    confirm: 'confirm',
  },
];

function makeAuthorization(index: number) {
  const conversationId = `conv-${String(index).padStart(3, '0')}`;
  return {
    conversationId,
    chatUrl: `https://chatgpt.com/c/${conversationId}`,
    authorizedAt: new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString(),
  };
}

function makeBinding(overrides: Partial<FeatureBinding> = {}): FeatureBinding {
  return {
    pluginInstanceId: 'official.companion.personal-chrome',
    featureId: 'personal-chrome-host',
    packageRevision: '0.1.0-alpha.1',
    integrityEpoch: 0,
    activationRevision: 0,
    grantRevision: 0,
    grantedCapabilities: ['data.directory', 'cloud.conversation.host'],
    executionLease: 'test-lease',
    ...overrides,
  };
}

function notImplemented(): never {
  throw new Error('not implemented in this test');
}

function makeAdapter() {
  const registrations: unknown[] = [];
  const disposals: unknown[] = [];
  const adapter: FeatureHostAdapter = {
    readConfig: () => notImplemented(),
    readSecret: () => notImplemented(),
    storage: {
      get: () => notImplemented(),
      list: () => notImplemented(),
      set: () => notImplemented(),
      compareAndSet: () => notImplemented(),
      delete: () => notImplemented(),
    },
    tasks: {
      get: () => notImplemented(),
      listByThread: () => notImplemented(),
      listByKind: () => notImplemented(),
      getBySubject: () => notImplemented(),
      create: () => notImplemented(),
      upsertBySubject: () => notImplemented(),
      update: () => notImplemented(),
      updateIfThreadId: () => notImplemented(),
    },
    threads: {
      get: () => notImplemented(),
      create: () => notImplemented(),
      update: () => notImplemented(),
      findByKey: () => notImplemented(),
      ensureByKey: () => notImplemented(),
      bind: () => notImplemented(),
      unbind: () => notImplemented(),
      listBindings: () => notImplemented(),
      ensureSystemThread: () => notImplemented(),
    },
    registerContribution: async (_binding, contribution) => {
      registrations.push(contribution);
      return { registrationId: 'test-registration', registryRevision: 0 };
    },
    disposeContribution: async (_binding, receipt) => {
      disposals.push(receipt);
    },
    sendMessage: () => notImplemented(),
    subscribeMessage: () => notImplemented(),
    unsubscribeMessage: () => notImplemented(),
    readMedia: () => notImplemented(),
    log: () => undefined,
  };
  return { adapter, registrations, disposals };
}

test('reading context.dataDirectory without the data.directory grant throws PERMISSION', () => {
  const { adapter } = makeAdapter();
  const { context } = createFeatureContextSession(
    makeBinding({ grantedCapabilities: ['cloud.conversation.host'] }),
    adapter,
  );
  assert.throws(
    () => context.dataDirectory,
    (error: unknown) => error instanceof FeaturePermissionError && error.code === 'PERMISSION',
  );
});

test('a granted binding exposes the provisioned data directory and revokes registrations', async () => {
  const { adapter, registrations, disposals } = makeAdapter();
  const { context, revoke } = createFeatureContextSession(
    makeBinding({ dataDirectory: '/tmp/personal-chrome-host-test' }),
    adapter,
  );
  assert.equal(context.dataDirectory, '/tmp/personal-chrome-host-test');
  const registration = await context.conversationHosts.register({
    id: 'personal-chrome-chatgpt-host',
    provider: 'chatgpt',
    appendMessage: { method: 'personal-chrome-host.append-message' },
    assistantReturns: {
      list: { method: 'personal-chrome-host.assistant-returns.list' },
      ack: { method: 'personal-chrome-host.assistant-returns.ack' },
    },
  });
  assert.equal(registrations.length, 1);
  await revoke();
  assert.equal(disposals.length, 1);
  await registration.dispose().catch(() => undefined);
});

test('authorization list→revoke round trip in a temporary data directory, with the 32-entry ceiling', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-chrome-module-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authorizationPath = join(directory, 'conversation-binding.json');
  const operations = createAuthorizationOperations({ authorizationPath });

  const empty = await operations.list();
  assert.equal(empty.render, 'rows');
  const emptyValidation = validateOperationRowsResult(
    { actions: ROW_OPERATION_ACTIONS },
    empty.data,
  );
  assert.equal(emptyValidation.valid, true);
  assert.equal((empty.data as OperationRows).rows.length, 0);

  for (let index = 0; index < PERSONAL_CHROME_AUTHORIZATION_LIMIT; index += 1) {
    await authorizePersonalChromeConversation(authorizationPath, makeAuthorization(index));
  }
  const collection = await readPersonalChromeConversationAuthorizations(authorizationPath);
  assert.equal(collection.conversations.length, PERSONAL_CHROME_AUTHORIZATION_LIMIT);

  await assert.rejects(
    authorizePersonalChromeConversation(authorizationPath, makeAuthorization(999)),
    (error: unknown) =>
      typeof error === 'object' && error !== null && (error as { code?: string }).code === 'AUTHORIZATION_LIMIT_REACHED',
  );

  await writeConversationTitles(authorizationPath, collection.conversations, [
    {
      conversationId: 'conv-000',
      authorizedAt: collection.conversations[0]!.authorizedAt,
      displayTitle: 'Trip planning',
      observedAt: collection.conversations[0]!.updatedAt,
    },
  ]);

  const listed = await operations.list();
  assert.equal(listed.render, 'rows');
  const rows = (listed.data as OperationRows).rows;
  assert.equal(rows.length, PERSONAL_CHROME_AUTHORIZATION_LIMIT);
  const first = rows.find((row) => row.key === 'conv-000')!;
  assert.equal(first.label, 'Trip planning');
  assert.equal(first.detail, 'https://chatgpt.com/c/conv-000');
  assert.deepEqual(first.actions, [
    { action: 'revoke', input: { conversationId: 'conv-000' } },
  ]);
  const fallback = rows.find((row) => row.key === 'conv-001')!;
  assert.equal(fallback.label, 'conv-001');
  for (const row of rows) {
    assert.ok(isPersonalChromeConversationId(row.key));
    assert.ok(row.label.length >= 1 && row.label.length <= 200);
  }
  const validation = validateOperationRowsResult({ actions: ROW_OPERATION_ACTIONS }, listed.data);
  assert.equal(validation.valid, true, JSON.stringify(validation.valid ? [] : validation.errors));

  const revoked = await operations.revoke({ conversationId: 'conv-000' });
  assert.equal(revoked.render, 'rows');
  assert.equal((revoked.data as OperationRows).rows.length, PERSONAL_CHROME_AUTHORIZATION_LIMIT - 1);
  assert.equal(
    (revoked.data as OperationRows).rows.some((row) => row.key === 'conv-000'),
    false,
  );
  const after = await readPersonalChromeConversationAuthorizations(authorizationPath);
  assert.equal(after.conversations.length, PERSONAL_CHROME_AUTHORIZATION_LIMIT - 1);
});

test('buildAuthorizationRows truncates long titles to the 200-character row label bound', () => {
  const authorization = makeAuthorization(1);
  const rows = buildAuthorizationRows(
    {
      schemaVersion: 2,
      provider: 'chatgpt',
      conversations: [authorization],
      updatedAt: authorization.updatedAt,
    },
    [
      {
        conversationId: authorization.conversationId,
        authorizedAt: authorization.authorizedAt,
        displayTitle: '长'.repeat(300),
        observedAt: authorization.updatedAt,
      },
    ],
  );
  assert.equal(rows[0]!.label.length, 200);
});
