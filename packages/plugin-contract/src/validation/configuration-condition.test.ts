import assert from 'node:assert/strict';
import test from 'node:test';

import { validateManifest } from './manifest.js';

function conditionManifest(): Record<string, unknown> {
  return {
    pluginId: 'dev.clowder.configuration-condition-fixture',
    version: '1.0.0',
    contractVersion: '0.1.0-beta.19',
    name: 'Configuration condition fixture',
    configuration: [
      {
        key: 'mode',
        label: 'Mode',
        kind: 'select',
        required: true,
        default: 'webhook',
        options: [
          { value: 'webhook', label: 'Webhook' },
          { value: 'websocket', label: 'WebSocket' },
        ],
      },
      {
        key: 'verificationToken',
        label: 'Verification token',
        kind: 'secret',
        required: true,
        hidden: true,
        requiredWhen: { key: 'mode', value: 'webhook' },
      },
      {
        key: 'enabled',
        label: 'Enabled',
        kind: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'attempts',
        label: 'Attempts',
        kind: 'number',
        required: false,
        requiredWhen: { key: 'enabled', value: true },
      },
      {
        key: 'endpoint',
        label: 'Endpoint',
        kind: 'url',
        required: false,
        requiredWhen: { key: 'attempts', value: [1, 2] },
      },
      {
        key: 'login',
        label: 'Log in',
        kind: 'operation',
        required: true,
        actions: [
          {
            id: 'begin',
            label: 'Begin',
            render: 'button',
            action: { method: 'login.begin' },
          },
        ],
      },
    ],
    features: [
      {
        id: 'configuration',
        name: 'Configuration',
        resources: [],
        capabilities: [],
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

test('admits hidden scalar fields and scalar-compatible conditional requirements', () => {
  assert.equal(validateManifest(conditionManifest()).valid, true);
});

test('rejects requiredWhen references outside the same manifest', () => {
  const manifest = structuredClone(conditionManifest());
  const fields = manifest.configuration as Array<Record<string, unknown>>;
  fields[1].requiredWhen = { key: 'missing', value: 'webhook' };

  assert.match(errorsOf(manifest).join('\n'), /requiredWhen key must reference a declared configuration field/);
});

test('rejects requiredWhen references to operation and other non-scalar fields', () => {
  const operation = structuredClone(conditionManifest());
  const operationFields = operation.configuration as Array<Record<string, unknown>>;
  operationFields[1].requiredWhen = { key: 'login', value: 'begin' };
  assert.match(
    errorsOf(operation).join('\n'),
    /requiredWhen key must reference a non-operation scalar configuration field/,
  );

  const nonScalar = structuredClone(conditionManifest());
  const nonScalarFields = nonScalar.configuration as Array<Record<string, unknown>>;
  nonScalarFields.splice(5, 0, {
    key: 'recipients',
    label: 'Recipients',
    kind: 'list',
    required: false,
  });
  nonScalarFields[1].requiredWhen = { key: 'recipients', value: 'owner' };
  assert.match(errorsOf(nonScalar).join('\n'), /kind|must be equal to one of the allowed values/);
});

test('rejects requiredWhen values that do not match the referenced scalar type', () => {
  const booleanMismatch = structuredClone(conditionManifest());
  const booleanFields = booleanMismatch.configuration as Array<Record<string, unknown>>;
  booleanFields[3].requiredWhen = { key: 'enabled', value: 'true' };
  assert.match(
    errorsOf(booleanMismatch).join('\n'),
    /requiredWhen value must match the referenced boolean configuration field/,
  );

  const numberMismatch = structuredClone(conditionManifest());
  const numberFields = numberMismatch.configuration as Array<Record<string, unknown>>;
  numberFields[4].requiredWhen = { key: 'attempts', value: [1, '2'] };
  assert.match(
    errorsOf(numberMismatch).join('\n'),
    /requiredWhen value must match the referenced number configuration field/,
  );
});

test('rejects hidden and requiredWhen on operation fields', () => {
  const hidden = structuredClone(conditionManifest());
  const hiddenFields = hidden.configuration as Array<Record<string, unknown>>;
  hiddenFields[5].hidden = true;
  assert.match(errorsOf(hidden).join('\n'), /hidden/);

  const conditional = structuredClone(conditionManifest());
  const conditionalFields = conditional.configuration as Array<Record<string, unknown>>;
  conditionalFields[5].requiredWhen = { key: 'mode', value: 'webhook' };
  assert.match(errorsOf(conditional).join('\n'), /requiredWhen/);
});
