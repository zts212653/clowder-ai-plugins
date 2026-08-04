import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  acceptSessionBinding,
  beginLocalHandshake,
  prepareActivation,
} from '@clowder-ai/plugin-sdk';

const packageDigest = `sha512-${'A'.repeat(85)}A==`;

const candidateHello = {
  pluginId: 'example.loopback',
  packageDigest,
  contractVersion: '0.1.0',
  wireVersion: '0.1.0',
} as const;

function sessionBinding(overrides: Record<string, unknown> = {}) {
  return {
    ...candidateHello,
    pluginInstanceId: 'instance-1',
    brokerSessionId: 'session-1',
    grantRevision: 0,
    effectiveGrants: [],
    bindingNonce: 'binding-nonce',
    ...overrides,
  };
}

function expectAccepted<T extends { readonly accepted: boolean }>(transition: T): asserts transition is T & { readonly accepted: true } {
  assert.equal(transition.accepted, true);
}

test('models the candidate → binding → activation sequence as local intents only', () => {
  const candidate = beginLocalHandshake(candidateHello);
  expectAccepted(candidate);
  assert.equal(candidate.state.phase, 'candidate');
  assert.deepEqual(candidate.intent, {
    kind: 'candidate',
    transport: 'local-only',
    candidate: candidateHello,
    validation: { reservedFields: 'structural', closedFields: 'full' },
  });

  const binding = acceptSessionBinding(candidate.state, sessionBinding());
  expectAccepted(binding);
  assert.equal(binding.state.phase, 'bound');
  assert.equal(binding.intent.kind, 'binding');
  assert.equal(binding.intent.transport, 'local-only');
  assert.deepEqual(binding.intent.validation, {
    reservedFields: 'structural',
    closedFields: 'full',
  });

  const activation = prepareActivation(binding.state, { bindingNonce: 'binding-nonce' });
  expectAccepted(activation);
  assert.equal(activation.state.phase, 'activated');
  assert.deepEqual(activation.intent, {
    kind: 'activation',
    transport: 'local-only',
    ready: { bindingNonce: 'binding-nonce' },
    validation: { reservedFields: 'none', closedFields: 'full' },
  });
});

test('feeds fake Host objects through an object-mode seam without creating wire frames', async () => {
  const candidate = beginLocalHandshake(candidateHello);
  expectAccepted(candidate);

  const fakeHost = new PassThrough({ objectMode: true });
  const transitions: ReturnType<typeof acceptSessionBinding>[] = [];
  fakeHost.on('data', binding => transitions.push(acceptSessionBinding(candidate.state, binding)));

  const ended = once(fakeHost, 'end');
  fakeHost.end(sessionBinding());
  await ended;

  assert.equal(transitions.length, 1);
  const [binding] = transitions;
  assert.ok(binding !== undefined);
  expectAccepted(binding);
  assert.equal(binding.intent.transport, 'local-only');

  const activation = prepareActivation(binding.state, { bindingNonce: 'binding-nonce' });
  expectAccepted(activation);
  assert.equal(activation.intent.transport, 'local-only');
});

test('validates CLOSED binding fields without inventing grammar for RESERVED identity fields', () => {
  const candidate = beginLocalHandshake(candidateHello);
  expectAccepted(candidate);

  const structurallyReserved = acceptSessionBinding(
    candidate.state,
    sessionBinding({ pluginInstanceId: '', brokerSessionId: '' }),
  );
  expectAccepted(structurallyReserved);

  const duplicateGrants = acceptSessionBinding(
    candidate.state,
    sessionBinding({ effectiveGrants: ['plugin.config.read', 'plugin.config.read'] }),
  );
  assert.deepEqual(duplicateGrants, {
    accepted: false,
    reason: 'AUTHORITY_VIOLATION',
    state: { phase: 'rejected', reason: 'AUTHORITY_VIOLATION' },
  });

  const nonStringReservedField = acceptSessionBinding(
    candidate.state,
    sessionBinding({ pluginInstanceId: 42 }),
  );
  assert.equal(nonStringReservedField.accepted, false);
  assert.equal(nonStringReservedField.reason, 'AUTHORITY_VIOLATION');
});

test('rejects invalid CLOSED binding values without narrowing RESERVED field grammar', () => {
  const candidate = beginLocalHandshake(candidateHello);
  expectAccepted(candidate);

  const invalidBindings = [
    ['non-WireUInt53 grant revision', { grantRevision: 1.5 }],
    ['unknown effective grant', { effectiveGrants: ['not.a.contract.capability'] }],
    ['overlong binding nonce', { bindingNonce: 'n'.repeat(513) }],
  ] as const;

  for (const [description, overrides] of invalidBindings) {
    const rejected = acceptSessionBinding(candidate.state, sessionBinding(overrides));
    assert.equal(rejected.accepted, false, description);
    assert.equal(rejected.reason, 'AUTHORITY_VIOLATION', description);
  }
});

test('rejects malformed candidates and mismatched authoritative bindings through closed reasons', () => {
  assert.deepEqual(beginLocalHandshake({ ...candidateHello, packageDigest: 'sha512-not-a-digest' }), {
    accepted: false,
    reason: 'MALFORMED_HELLO',
    state: { phase: 'rejected', reason: 'MALFORMED_HELLO' },
  });

  const candidate = beginLocalHandshake(candidateHello);
  expectAccepted(candidate);
  const mismatch = acceptSessionBinding(
    candidate.state,
    sessionBinding({ packageDigest: `sha512-${'B'.repeat(85)}A==` }),
  );
  assert.equal(mismatch.accepted, false);
  assert.equal(mismatch.reason, 'PACKAGE_MISMATCH');

  const contractMismatch = acceptSessionBinding(
    candidate.state,
    sessionBinding({ contractVersion: 'other-compatible-later' }),
  );
  assert.equal(contractMismatch.accepted, false);
  assert.equal(contractMismatch.reason, 'CONTRACT_INCOMPATIBLE');

  const wireMismatch = acceptSessionBinding(
    candidate.state,
    sessionBinding({ wireVersion: 'other-wire-later' }),
  );
  assert.equal(wireMismatch.accepted, false);
  assert.equal(wireMismatch.reason, 'WIRE_INCOMPATIBLE');
});

test('rejects out-of-order and nonce-mismatched activation without creating a wire frame', () => {
  const candidate = beginLocalHandshake(candidateHello);
  expectAccepted(candidate);

  const outOfOrder = prepareActivation(candidate.state, { bindingNonce: 'binding-nonce' });
  assert.deepEqual(outOfOrder, {
    accepted: false,
    reason: 'BINDING_REPLAY',
    state: { phase: 'rejected', reason: 'BINDING_REPLAY' },
  });

  const binding = acceptSessionBinding(candidate.state, sessionBinding());
  expectAccepted(binding);
  const mismatch = prepareActivation(binding.state, { bindingNonce: 'different-nonce' });
  assert.equal(mismatch.accepted, false);
  assert.equal(mismatch.reason, 'BINDING_REPLAY');
});
