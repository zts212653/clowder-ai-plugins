import assert from 'node:assert/strict';
import test from 'node:test';

import { validateManifest } from './manifest.js';

function operationManifest(): Record<string, unknown> {
  return {
    pluginId: 'dev.clowder.operation-fixture',
    version: '1.0.0',
    contractVersion: '0.1.0-beta.18',
    name: 'Operation fixture',
    configuration: [
      {
        key: 'account',
        label: 'Account',
        kind: 'string',
        required: true,
      },
      {
        key: 'credential',
        label: 'Credential',
        kind: 'secret',
        required: true,
      },
      {
        key: 'login',
        label: 'Log in',
        description: 'Complete the provider login flow.',
        kind: 'operation',
        required: true,
        target: ['account', 'credential'],
        actions: [
          {
            id: 'begin',
            label: 'Begin',
            render: 'button',
            action: { method: 'login.begin', params: { interactive: true } },
            next: 'poll',
          },
          {
            id: 'poll',
            label: 'Wait for confirmation',
            render: 'polling',
            action: { method: 'login.poll' },
            resultRender: 'status',
            next: 'complete',
            rollback: 'begin',
            timeout: 30,
          },
          {
            id: 'complete',
            label: 'Connected',
            render: 'status',
            action: { method: 'login.complete' },
          },
        ],
      },
    ],
    test: { action: { method: 'plugin.test' } },
    steps: [{ text: 'Open the login flow.' }, { text: 'Confirm the account.' }],
    features: [
      {
        id: 'login',
        name: 'Login',
        resources: [],
        capabilities: ['plugin.config.read', 'secret.read'],
      },
    ],
    runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js' },
  };
}

function errorsOf(value: unknown): readonly string[] {
  const result = validateManifest(value);
  assert.equal(result.valid, false);
  return result.valid
    ? []
    : result.errors.map((error) => `${error.instancePath}: ${error.message}`);
}

test('admits operation, test, and setup-step declarations with one runtime', () => {
  assert.equal(validateManifest(operationManifest()).valid, true);
});

test('admits a runtime-less package containing only self-contained static resources', () => {
  const manifest = {
    pluginId: 'dev.clowder.static-fixture',
    version: '1.0.0',
    contractVersion: '0.1.0-beta.18',
    name: 'Static fixture',
    contributions: [
      { type: 'skill', id: 'guide', path: 'skills/guide' },
      {
        type: 'mcp',
        id: 'search',
        runtime: { transport: 'stdio', entrypoint: 'dist/mcp.js' },
      },
    ],
    features: [
      {
        id: 'static',
        name: 'Static resources',
        resources: [],
        contributions: [
          { type: 'skill', id: 'guide' },
          { type: 'mcp', id: 'search' },
        ],
        capabilities: [],
      },
    ],
  };

  assert.equal(validateManifest(manifest).valid, true);
});

test('rejects malformed operation declarations at the schema boundary', () => {
  const withoutActions = structuredClone(operationManifest());
  const operation = (withoutActions.configuration as Array<Record<string, unknown>>)[2];
  delete operation.actions;
  assert.match(errorsOf(withoutActions).join('\n'), /actions/);

  const withDefault = structuredClone(operationManifest());
  (withDefault.configuration as Array<Record<string, unknown>>)[2].default = false;
  assert.match(errorsOf(withDefault).join('\n'), /default/);

  const emptyTestMethod = structuredClone(operationManifest());
  ((emptyTestMethod.test as Record<string, unknown>).action as Record<string, unknown>).method = '';
  assert.match(errorsOf(emptyTestMethod).join('\n'), /\/test\/action\/method/);
});

test('rejects duplicate and dangling operation action references', () => {
  const duplicate = structuredClone(operationManifest());
  const duplicateActions = (
    (duplicate.configuration as Array<Record<string, unknown>>)[2].actions as Array<Record<string, unknown>>
  );
  duplicateActions[1].id = 'begin';
  assert.match(errorsOf(duplicate).join('\n'), /action id must be unique/);

  const dangling = structuredClone(operationManifest());
  const danglingActions = (
    (dangling.configuration as Array<Record<string, unknown>>)[2].actions as Array<Record<string, unknown>>
  );
  danglingActions[0].next = 'missing';
  assert.match(errorsOf(dangling).join('\n'), /next must reference an action in the same operation/);
});

test('rejects operation targets that are absent or themselves operations', () => {
  const unknown = structuredClone(operationManifest());
  (unknown.configuration as Array<Record<string, unknown>>)[2].target = ['missing'];
  assert.match(errorsOf(unknown).join('\n'), /target must reference a declared non-operation configuration key/);

  const recursive = structuredClone(operationManifest());
  (recursive.configuration as Array<Record<string, unknown>>)[2].target = ['login'];
  assert.match(errorsOf(recursive).join('\n'), /target must reference a declared non-operation configuration key/);
});

test('requires a package runtime for callback and handler contributions', () => {
  const manifest = {
    pluginId: 'dev.clowder.webhook-fixture',
    version: '1.0.0',
    contractVersion: '0.1.0-beta.18',
    name: 'Webhook fixture',
    contributions: [
      {
        type: 'webhook',
        id: 'events',
        path: 'events',
        methods: ['POST'],
        action: { method: 'webhook.receive' },
      },
    ],
    features: [
      {
        id: 'webhook',
        name: 'Webhook',
        resources: [],
        contributions: [{ type: 'webhook', id: 'events' }],
        capabilities: [],
      },
    ],
  };

  assert.match(errorsOf(manifest).join('\n'), /runtime is required by contribution events/);

  const operation = structuredClone(operationManifest());
  delete operation.runtime;
  assert.match(errorsOf(operation).join('\n'), /runtime is required by configuration login/);

  const testOnly = structuredClone(operationManifest());
  delete testOnly.runtime;
  delete testOnly.configuration;
  assert.match(
    errorsOf(testOnly).join('\n'),
    /runtime is required by test dev\.clowder\.operation-fixture/,
  );
});
