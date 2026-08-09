import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SIGNAL_PAYLOAD_MAX_ENCODED_BYTES,
  validateDeclaredEventsPublishInput,
  validateEventsPublishInput,
  validateEventsPublishResult,
  validateSignalDeclaration,
} from '../index.js';

const declaration = {
  type: 'feishu.meeting_artifact.generated.v1',
  schemaRef: 'schemas/feishu-meeting-artifact.v1.schema.json',
  epistemicStatus: 'observation',
  privacyClass: 'content-adjacent',
  sourceClass: 'remote-service',
} as const;

const signalSchemas = {
  [declaration.schemaRef]: {
    type: 'object',
    properties: {
      payload: {
        type: 'object',
        properties: {
          artifactId: { type: 'string' },
          kind: { const: 'minutes' },
          title: { type: 'string' },
        },
        required: ['artifactId', 'kind'],
        additionalProperties: false,
      },
      source: {
        type: 'object',
        properties: {
          handle: { type: 'string', pattern: '^feishu-minute:[A-Za-z0-9._:-]+$' },
        },
        required: ['handle'],
        additionalProperties: false,
      },
    },
    required: ['payload', 'source'],
    additionalProperties: false,
  },
} as const;

function publishInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    signalType: declaration.type,
    eventId: 'feishu-event-1',
    idempotencyKey: 'feishu-artifact-1',
    occurredAt: '2026-08-09T05:55:00Z',
    payload: {
      artifactId: 'artifact-1',
      kind: 'minutes',
      title: 'F292 Gate',
    },
    source: { handle: 'feishu-minute:artifact-1' },
    ...overrides,
  };
}

test('accepts the first real remote-service signal declaration', () => {
  assert.deepEqual(validateSignalDeclaration(declaration), {
    valid: true,
    value: declaration,
    errors: [],
  });
});

test('rejects forbidden classes, user intent, and non-package schema refs', () => {
  const invalid = [
    { ...declaration, privacyClass: 'av-raw' },
    { ...declaration, privacyClass: 'input-raw' },
    { ...declaration, sourceClass: 'av-capture' },
    { ...declaration, sourceClass: 'input-hardware' },
    { ...declaration, epistemicStatus: 'user_intent' },
    { ...declaration, schemaRef: 'https://attacker.example/schema.json' },
    { ...declaration, schemaRef: 'schemas/../secret.schema.json' },
  ];

  for (const value of invalid) {
    assert.equal(validateSignalDeclaration(value).valid, false, JSON.stringify(value));
  }
});

test('accepts the bounded row-13 publish input and Host-issued receipt', () => {
  assert.equal(validateEventsPublishInput(publishInput()).valid, true);
  assert.equal(
    validateEventsPublishResult({
      publicationId: 'publication-1',
      disposition: 'accepted',
    }).valid,
    true,
  );
  assert.equal(
    validateEventsPublishResult({
      publicationId: 'publication-1',
      disposition: 'duplicate',
    }).valid,
    true,
  );
});

test('binds publish admission to the manifest-declared signal types', () => {
  assert.equal(
    validateDeclaredEventsPublishInput([declaration], signalSchemas, publishInput()).valid,
    true,
  );
  const result = validateDeclaredEventsPublishInput(
    [{ ...declaration, type: 'another.source.generated.v1' }],
    signalSchemas,
    publishInput(),
  );
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.errors[0]?.keyword, 'declaredSignalType');
});

test('binds publish admission to the resolved package schema and required source', () => {
  for (const value of [
    publishInput({ payload: { transcript: 'must not cross ingress' } }),
    publishInput({ source: undefined }),
    publishInput({ source: { handle: 'https://attacker.example/transcript' } }),
  ]) {
    const result = validateDeclaredEventsPublishInput(
      [declaration],
      signalSchemas,
      value,
    );
    assert.equal(result.valid, false, JSON.stringify(value));
  }

  const unresolved = validateDeclaredEventsPublishInput(
    [declaration],
    {},
    publishInput(),
  );
  assert.equal(unresolved.valid, false);
  if (!unresolved.valid) assert.equal(unresolved.errors[0]?.keyword, 'signalSchemaUnresolved');
});

test('rejects plugin-owned authority fields and malformed source handles', () => {
  for (const value of [
    publishInput({ target: { threadId: 'thread-1' } }),
    publishInput({ producer: { pluginInstanceId: 'forged' } }),
    publishInput({ epistemicStatus: 'user_intent' }),
    publishInput({ leaseExpiry: Number.MAX_SAFE_INTEGER }),
    publishInput({ source: undefined }),
    publishInput({ source: { handle: '' } }),
    publishInput({ source: { handle: 'x'.repeat(513) } }),
  ]) {
    assert.equal(validateEventsPublishInput(value).valid, false, JSON.stringify(value));
  }
});

test('rejects non-scalar idempotency keys and source handles', () => {
  for (const value of [
    publishInput({ idempotencyKey: '\ud800'.repeat(256) }),
    publishInput({ source: { handle: '\ud800'.repeat(512) } }),
  ]) {
    assert.equal(validateEventsPublishInput(value).valid, false, JSON.stringify(value));
  }
});

test('enforces the compact 64 KiB payload budget in UTF-8 bytes', () => {
  assert.equal(SIGNAL_PAYLOAD_MAX_ENCODED_BYTES, 65_536);
  assert.equal(
    validateEventsPublishInput(publishInput({ payload: { text: 'x'.repeat(65_520) } })).valid,
    true,
  );
  assert.equal(
    validateEventsPublishInput(publishInput({ payload: { text: '😀'.repeat(20_000) } })).valid,
    false,
  );
});

test('rejects noncanonical timestamps, invalid identifiers, and open receipts', () => {
  for (const value of [
    publishInput({ occurredAt: '2026-08-09T05:55:00+00:00' }),
    publishInput({ eventId: '' }),
    publishInput({ idempotencyKey: 'x'.repeat(257) }),
    publishInput({ payload: [] }),
  ]) {
    assert.equal(validateEventsPublishInput(value).valid, false, JSON.stringify(value));
  }
  assert.equal(
    validateEventsPublishResult({
      publicationId: 'publication-1',
      disposition: 'accepted',
      route: 'thread-1',
    }).valid,
    false,
  );
});

test('fails closed instead of throwing on recursively hostile payloads', () => {
  let payload: Record<string, unknown> = { leaf: 'value' };
  for (let depth = 0; depth < 20_000; depth += 1) payload = { child: payload };

  let result: { readonly valid: boolean } | undefined;
  try {
    result = validateEventsPublishInput(publishInput({ payload }));
  } catch (error) {
    assert.fail(`validator must fail closed instead of throwing: ${String(error)}`);
  }
  assert.ok(result !== undefined);
  assert.equal(result.valid, false);
});
