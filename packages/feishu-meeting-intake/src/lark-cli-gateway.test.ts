import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

import {
  classifyLarkCliFailure,
  createLarkCliFeishuEventGateway,
  larkCliChildEnvironment,
  resolveBundledLarkCliEntrypoint,
  type LarkCliEventConsumer,
} from './lark-cli-gateway.js';
import { FeishuGatewayError } from './gateway.js';
import { normalizeLarkCliGeneratedEvent } from './lark-event-normalizer.js';

const SIGNAL = new AbortController().signal;

async function* events(values: readonly unknown[]): AsyncGenerator<unknown> {
  for (const value of values) yield value;
  await new Promise<never>(() => undefined);
}

async function* eventsUntilEnded(ended: Promise<void>): AsyncGenerator<unknown> {
  await ended;
  yield* [];
}

function deferred<Value = void>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

test('maps minute and note events to bounded descriptors without transcript or destination authority', () => {
  assert.deepEqual(normalizeLarkCliGeneratedEvent({
    type: 'minutes.minute.generated_v1',
    event_id: 'evt-minute-1',
    timestamp: '1786381200000',
    minute_token: 'obcn_minute_1',
    title: 'F292 dogfood',
    minute_source: { source_type: 'meeting', source_entity_id: 'meeting_1' },
  }), {
    artifactId: 'obcn_minute_1',
    kind: 'minute',
    revision: 'evt-minute-1',
    generatedAt: '2026-08-10T17:00:00.000Z',
    title: 'F292 dogfood',
    meetingId: 'meeting_1',
  });

  assert.deepEqual(normalizeLarkCliGeneratedEvent({
    type: 'vc.note.generated_v1',
    event_id: 'evt-note-1',
    timestamp: '1786381200000',
    note_id: 'note_1',
    note_token: 'doc_1',
    verbatim_token: 'doc_verbatim_1',
    note_source: { source_type: 'meeting', source_entity_id: 'meeting_1' },
  }), {
    artifactId: 'note_1',
    kind: 'note',
    revision: 'evt-note-1',
    generatedAt: '2026-08-10T17:00:00.000Z',
    meetingId: 'meeting_1',
  });

  for (const candidate of [
    { type: 'minutes.minute.generated_v1', event_id: 'evt', timestamp: '1', minute_token: '../../x' },
    { type: 'minutes.minute.generated_v1', event_id: 'evt', timestamp: '1', minute_token: 'ok', transcript: 'leak' },
    { type: 'minutes.minute.generated_v1', event_id: 'evt', timestamp: '1', minute_token: 'ok', destination: 'thread-1' },
    { type: 'unknown', event_id: 'evt', timestamp: '1', minute_token: 'ok' },
  ]) {
    assert.throws(() => normalizeLarkCliGeneratedEvent(candidate));
  }
});

test('resolves the package-owned lark-cli runner and gives it only the derived home directory', () => {
  const runner = resolveBundledLarkCliEntrypoint();
  assert.equal(existsSync(runner), true);
  assert.match(runner, /@larksuite[\\/]cli[\\/]scripts[\\/]run\.js$/u);
  assert.deepEqual(larkCliChildEnvironment('/Users/example'), { HOME: '/Users/example' });
});

test('classifies the structured global event-bus collision without copying remote diagnostics', () => {
  const failure = classifyLarkCliFailure([
    '[event] connecting',
    JSON.stringify({
      error: {
        type: 'validation',
        subtype: 'failed_precondition',
        message: 'another event bus owns secret-account@example.com',
      },
    }),
  ].join('\n'));

  assert.equal(failure.code, 'EVENT_BUS_CONFLICT');
  assert.equal(failure.message, 'another Feishu event bus owns this application');
  assert.doesNotMatch(failure.message, /secret-account/u);
});

test('start confirms both generated-event sources without waiting for an event', async () => {
  let starts = 0;
  const gateway = createLarkCliFeishuEventGateway({
    createConsumer: async () => {
      starts += 1;
      return {
        events: events([]),
        close: async () => undefined,
      };
    },
  });

  await gateway.start();
  assert.equal(starts, 2);
  await gateway.close();
});

test('start rejects stalled source readiness with a typed unavailable failure', async () => {
  let aborted = false;
  const gateway = createLarkCliFeishuEventGateway({
    sourceReadinessDeadlineMs: 5,
    createConsumer: async (_eventKey, signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
  });

  const outcome = await Promise.race([
    gateway.start().then(
      () => ({ kind: 'resolved' as const }),
      error => ({ kind: 'rejected' as const, error }),
    ),
    new Promise<{ readonly kind: 'timed-out' }>(resolve => {
      setTimeout(() => resolve({ kind: 'timed-out' }), 50);
    }),
  ]);

  assert.equal(outcome.kind, 'rejected');
  if (outcome.kind !== 'rejected') return;
  assert.ok(outcome.error instanceof FeishuGatewayError);
  assert.equal(outcome.error.code, 'UNAVAILABLE');
  assert.match(outcome.error.message, /source readiness deadline expired/u);
  assert.equal(aborted, true, 'deadline must abort stalled consumer startup');
  await gateway.close();
});

test('start rejects when an opened source ends while the next source is still starting', async () => {
  const endFirstSource = deferred();
  const secondSourceStarted = deferred();
  const releaseSecondSource = deferred();
  let starts = 0;
  let closes = 0;
  const gateway = createLarkCliFeishuEventGateway({
    createConsumer: async () => {
      starts += 1;
      if (starts === 1) {
        return {
          events: eventsUntilEnded(endFirstSource.promise),
          close: async () => {
            closes += 1;
          },
        };
      }
      secondSourceStarted.resolve();
      await releaseSecondSource.promise;
      return {
        events: events([]),
        close: async () => {
          closes += 1;
        },
      };
    },
  });

  const starting = gateway.start();
  await secondSourceStarted.promise;
  endFirstSource.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
  releaseSecondSource.resolve();

  await assert.rejects(
    starting,
    error => error instanceof FeishuGatewayError &&
      error.code === 'UNAVAILABLE' &&
      /generated-event source ended/u.test(error.message),
  );
  assert.equal(closes, 2, 'startup failure must close every opened lark-cli process');
  await gateway.close();
});

test('start rejects when the final source ends during the pump handoff', async () => {
  let starts = 0;
  let closes = 0;
  const gateway = createLarkCliFeishuEventGateway({
    createConsumer: async () => {
      starts += 1;
      return {
        events: starts === 1 ? events([]) : eventsUntilEnded(Promise.resolve()),
        close: async () => {
          closes += 1;
        },
      };
    },
  });

  await assert.rejects(
    gateway.start(),
    error => error instanceof FeishuGatewayError &&
      error.code === 'UNAVAILABLE' &&
      /generated-event source ended/u.test(error.message),
  );
  assert.equal(closes, 2, 'handoff failure must close every opened lark-cli process');
  await gateway.close();
});

test('combines the two generated-artifact streams and carries only an opaque cursor', async () => {
  const consumers: LarkCliEventConsumer[] = [
    { events: events([{
      type: 'minutes.minute.generated_v1',
      event_id: 'evt-minute-1',
      timestamp: '1786381200000',
      minute_token: 'obcn_minute_1',
      title: 'F292 dogfood',
    }]), close: async () => undefined },
    { events: events([{
      type: 'vc.note.generated_v1',
      event_id: 'evt-note-1',
      timestamp: '1786381200001',
      note_id: 'note_1',
    }]), close: async () => undefined },
  ];
  const gateway = createLarkCliFeishuEventGateway({
    createConsumer: async () => {
      const consumer = consumers.shift();
      assert.ok(consumer);
      return consumer;
    },
    inspectArtifact: async () => {
      throw new Error('not used');
    },
  });

  const page = await gateway.listGeneratedArtifacts({ cursor: null, limit: 64, signal: SIGNAL });
  assert.equal(page.artifacts.length, 2);
  assert.equal(page.nextCursor, 'evt-note-1');
  await gateway.close();
});

test('closes an opened event source when the second source cannot start', async () => {
  let starts = 0;
  let closes = 0;
  const gateway = createLarkCliFeishuEventGateway({
    createConsumer: async () => {
      starts += 1;
      if (starts === 2) throw new Error('second generated-event source unavailable');
      return {
        events: events([]),
        close: async () => {
          closes += 1;
        },
      };
    },
  });

  await assert.rejects(
    gateway.listGeneratedArtifacts({ cursor: null, limit: 64, signal: SIGNAL }),
    /second generated-event source unavailable/u,
  );
  assert.equal(closes, 1, 'partial startup must not leak the first lark-cli process');
  await gateway.close();
});
