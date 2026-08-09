import assert from 'node:assert/strict';
import test from 'node:test';

import type { EventsPublishInput } from '@clowder-ai/plugin-contract';

import type { ActivatedHandshakeState, LocalHandshakeState } from './handshake-client.js';
import {
  EventsPublishError,
  createEventsPublisher,
  type EventsPublishHostTransport,
} from './events-publisher.js';

const INPUT: EventsPublishInput = {
  signalType: 'feishu.meeting_artifact.generated.v1',
  eventId: 'feishu-minute-om_abc123-v7',
  idempotencyKey: 'feishu:minute:om_abc123:7',
  occurredAt: '2026-08-09T04:12:31Z',
  payload: {
    artifactId: 'om_abc123',
    artifactKind: 'minute',
    revision: '7',
  },
  source: { handle: 'feishu://minutes/om_abc123?revision=7' },
};

const DECLARED_SIGNALS = [
  {
    type: INPUT.signalType,
    schemaRef: 'schemas/feishu-meeting-artifact.schema.json',
    epistemicStatus: 'observation',
    privacyClass: 'content-adjacent',
    sourceClass: 'remote-service',
  },
] as const;

function activated(grants: readonly ('events.publish' | 'plugin.state.get')[] = ['events.publish']): ActivatedHandshakeState {
  return {
    phase: 'activated',
    candidate: {
      pluginId: 'official.feishu-meeting-intake',
      packageDigest: `sha512-${'A'.repeat(86)}==`,
      contractVersion: '0.1.0',
      wireVersion: '0.1.0',
    },
    binding: {
      pluginId: 'official.feishu-meeting-intake',
      packageDigest: `sha512-${'A'.repeat(86)}==`,
      contractVersion: '0.1.0',
      wireVersion: '0.1.0',
      pluginInstanceId: 'plugin-instance-1',
      brokerSessionId: 'broker-session-1',
      grantRevision: 4,
      effectiveGrants: grants,
      bindingNonce: 'binding-nonce-1',
    },
    activation: { bindingNonce: 'binding-nonce-1' },
  };
}

class RecordingTransport implements EventsPublishHostTransport {
  readonly calls: Array<{ method: string; input: EventsPublishInput }> = [];
  result: unknown = { publicationId: 'publication-1', disposition: 'accepted' };

  async call(method: 'events.publish', input: EventsPublishInput): Promise<unknown> {
    this.calls.push({ method, input });
    return this.result;
  }
}

function assertPublishError(
  error: unknown,
  code: EventsPublishError['code'],
): boolean {
  assert.ok(error instanceof EventsPublishError);
  assert.equal(error.code, code);
  return true;
}

test('publishes through the Host-bound row without adding routing authority', async () => {
  const transport = new RecordingTransport();
  let live = true;
  const publisher = createEventsPublisher({
    transport,
    declaredSignals: DECLARED_SIGNALS,
    getHandshakeState: () => activated(),
    liveness: { kind: 'stdio-session', isLive: () => live },
  });

  assert.deepEqual(await publisher.publish(INPUT), {
    publicationId: 'publication-1',
    disposition: 'accepted',
  });
  assert.deepEqual(transport.calls, [{ method: 'events.publish', input: INPUT }]);

  live = false;
  await assert.rejects(
    publisher.publish(INPUT),
    (error) => assertPublishError(error, 'SESSION_NOT_LIVE'),
  );
  assert.equal(transport.calls.length, 1, 'expired liveness must reject before transport');
});

test('requires an activated session and current events.publish grant', async () => {
  const transport = new RecordingTransport();
  const candidate: LocalHandshakeState = {
    phase: 'candidate',
    candidate: activated().candidate,
  };

  for (const [state, code] of [
    [candidate, 'SESSION_NOT_ACTIVATED'],
    [activated(['plugin.state.get']), 'GRANT_MISSING'],
  ] as const) {
    const publisher = createEventsPublisher({
      transport,
      declaredSignals: DECLARED_SIGNALS,
      getHandshakeState: () => state,
      liveness: { kind: 'stdio-session', isLive: () => true },
    });
    await assert.rejects(
      publisher.publish(INPUT),
      (error) => assertPublishError(error, code),
    );
  }

  assert.equal(transport.calls.length, 0);
});

test('rejects invalid or authority-bearing input before transport', async () => {
  const transport = new RecordingTransport();
  const publisher = createEventsPublisher({
    transport,
    declaredSignals: DECLARED_SIGNALS,
    getHandshakeState: () => activated(),
    liveness: { kind: 'stdio-session', isLive: () => true },
  });

  await assert.rejects(
    publisher.publish({ ...INPUT, destination: { threadId: 'thread-1' } }),
    (error) => assertPublishError(error, 'INVALID_INPUT'),
  );
  await assert.rejects(
    publisher.publish({ ...INPUT, payload: { text: 'a'.repeat(65_537) } }),
    (error) => assertPublishError(error, 'INVALID_INPUT'),
  );
  assert.equal(transport.calls.length, 0);
});

test('rejects a structurally valid but undeclared signal before transport', async () => {
  const transport = new RecordingTransport();
  const publisher = createEventsPublisher({
    transport,
    declaredSignals: [
      { ...DECLARED_SIGNALS[0], type: 'another.source.generated.v1' },
    ],
    getHandshakeState: () => activated(),
    liveness: { kind: 'stdio-session', isLive: () => true },
  });

  await assert.rejects(
    publisher.publish(INPUT),
    (error) => assertPublishError(error, 'SIGNAL_UNDECLARED'),
  );
  assert.equal(transport.calls.length, 0);
});

test('accepts duplicate receipts and fails closed on malformed Host results', async () => {
  const transport = new RecordingTransport();
  const publisher = createEventsPublisher({
    transport,
    declaredSignals: DECLARED_SIGNALS,
    getHandshakeState: () => activated(),
    liveness: { kind: 'stdio-session', isLive: () => true },
  });

  transport.result = { publicationId: 'publication-1', disposition: 'duplicate' };
  assert.deepEqual(await publisher.publish(INPUT), transport.result);

  transport.result = {
    publicationId: 'publication-1',
    disposition: 'accepted',
    destination: 'thread-1',
  };
  await assert.rejects(
    publisher.publish(INPUT),
    (error) => assertPublishError(error, 'INVALID_RESULT'),
  );
});
