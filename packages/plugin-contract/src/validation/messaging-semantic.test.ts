import assert from 'node:assert/strict';
import test from 'node:test';

import { validateMessagingSemantics } from './messaging-semantic.js';

function makeDraft(texts: readonly string[]): Record<string, unknown> {
  return {
    address: { kind: 'thread_handle', handle: 'host-issued-thread-handle' },
    idempotencyKey: 'fixture-semantic-limits',
    payload: {
      provenance: { epistemicStatus: 'inference' },
      elements: texts.map((text, index) => ({
        elementId: `text-${index}`,
        kind: 'text',
        payload: { text },
      })),
    },
  };
}

test('semantic validator accepts exact element and aggregate byte boundaries', () => {
  const result = validateMessagingSemantics(
    'MessageDraft',
    makeDraft(Array.from({ length: 4 }, () => 'x'.repeat(65_525))),
  );
  assert.deepEqual(result, { valid: true, errors: [] });
});

test('semantic validator rejects non-serializable element payloads', () => {
  const draft = makeDraft(['hello']);
  const cyclicPayload: Record<string, unknown> = {};
  cyclicPayload.self = cyclicPayload;
  const messagePayload = draft.payload as { elements: Array<Record<string, unknown>> };
  messagePayload.elements[0]!.payload = cyclicPayload;

  const result = validateMessagingSemantics('MessageDraft', draft);

  assert.equal(result.valid, false);
  assert.match(result.errors[0]?.message ?? '', /JSON-serializable/);
});

test('semantic validator rejects an element payload over 64 KiB', () => {
  const result = validateMessagingSemantics(
    'MessageDraft',
    makeDraft(['x'.repeat(70 * 1024)]),
  );

  assert.equal(result.valid, false);
  assert.match(result.errors[0]?.message ?? '', /65536 bytes/);
});

test('semantic validator rejects aggregate element payload over 256 KiB', () => {
  const result = validateMessagingSemantics(
    'MessageDraft',
    makeDraft(Array.from({ length: 5 }, () => 'x'.repeat(60 * 1024))),
  );

  assert.equal(result.valid, false);
  assert.match(result.errors.at(-1)?.message ?? '', /262144 bytes/);
});

test('semantic validator applies payload limits inside subscription events', () => {
  const draft = makeDraft(['x'.repeat(70 * 1024)]);
  const payload = draft.payload;
  const read = {
    events: [
      {
        eventId: 'event-1',
        sequence: 1,
        type: 'message.publish',
        envelope: {
          messageId: 'message-1',
          revision: 1,
          threadId: 'thread-1',
          actor: { kind: 'plugin', id: 'plugin-1' },
          audience: { kind: 'public' },
          occurredAt: '2026-07-15T00:00:00Z',
          payload,
        },
      },
    ],
    ackToken: 'ack-1',
    stale: false,
  };

  const result = validateMessagingSemantics('SubscriptionReadResponse', read);

  assert.equal(result.valid, false);
  assert.match(result.errors[0]?.message ?? '', /65536 bytes/);
});
