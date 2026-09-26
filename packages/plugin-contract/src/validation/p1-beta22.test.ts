import assert from 'node:assert/strict';
import test from 'node:test';

import { validateManifest } from './manifest.js';
import {
  validateMessagingRowInput,
  validateMessagingRowResult,
} from './messaging-wire.js';

const presentation = {
  actor: { displayName: 'Opus', emoji: '🐱' },
  thread: { shortId: 't-1', title: 'Thread', featId: 'F202' },
};

const startedEvent = {
  lifecycleId: 'life-1',
  deliveryId: 'delivery-1',
  threadId: 'thread-1',
  state: 'started',
  presentation,
};

test('beta.22 lifecycle started accepts placeholderLine and replyTo', () => {
  assert.equal(validateMessagingRowInput('host.messaging.lifecycle', startedEvent).valid, true);
  assert.equal(validateMessagingRowInput('host.messaging.lifecycle', {
    ...startedEvent,
    placeholderLine: 'Working on it…',
    replyTo: 'host-message-1',
  }).valid, true);
  assert.equal(validateMessagingRowInput('host.messaging.lifecycle', {
    ...startedEvent,
    placeholderLine: '',
  }).valid, false);
  assert.equal(validateMessagingRowInput('host.messaging.lifecycle', {
    ...startedEvent,
    placeholderLine: 'x'.repeat(257),
  }).valid, false);

  const unknownField = { ...startedEvent, sender: 'connector' } as Record<string, unknown>;
  assert.equal(validateMessagingRowInput('host.messaging.lifecycle', unknownField).valid, false);
});

test('beta.22 widens replyTo and messageId to the shared 512-byte MessageId bound', () => {
  const draft = (replyTo: string) => ({
    address: { kind: 'thread_handle', handle: 'thread-1' },
    idempotencyKey: 'p1-beta22',
    replyTo,
    payload: {
      provenance: { epistemicStatus: 'observation' },
      elements: [{ elementId: 'text-1', kind: 'text', payload: { text: 'hi' } }],
    },
  });
  assert.equal(validateMessagingRowInput('messaging.send', draft('r'.repeat(512))).valid, true);
  assert.equal(validateMessagingRowInput('messaging.send', draft('r'.repeat(513))).valid, false);

  const publishEvent = (envelope: Record<string, unknown>) => ({
    events: [{
      eventId: 'event-1',
      sequence: 0,
      type: 'message.publish',
      envelope: {
        messageId: 'm'.repeat(512),
        revision: 1,
        threadId: 'thread-1',
        replyTo: 'r'.repeat(512),
        actor: { kind: 'cat', id: 'cat-1' },
        audience: { kind: 'public' },
        occurredAt: '2026-09-25T00:00:00.000Z',
        payload: {
          provenance: { origin: { kind: 'host' }, epistemicStatus: 'observation' },
          elements: [{ elementId: 'text-1', kind: 'text', payload: { text: 'hi' } }],
        },
        ...envelope,
      },
    }],
    ackToken: 'cursor-1',
    stale: false,
  });
  assert.equal(validateMessagingRowResult('messaging.read', publishEvent({})).valid, true);
  assert.equal(validateMessagingRowResult('messaging.read', publishEvent({ replyTo: 'r'.repeat(513) })).valid, false);
  assert.equal(validateMessagingRowResult('messaging.read', publishEvent({ messageId: 'm'.repeat(513) })).valid, false);

  assert.equal(validateMessagingRowResult('messaging.send', {
    messageId: 'm'.repeat(512),
    threadId: 'thread-1',
    revision: 1,
    messageHandle: { kind: 'message', token: 'opaque-handle' },
  }).valid, true);
  assert.equal(validateMessagingRowResult('messaging.send', {
    messageId: 'm'.repeat(513),
    threadId: 'thread-1',
    revision: 1,
    messageHandle: { kind: 'message', token: 'opaque-handle' },
  }).valid, false);

  assert.equal(validateMessagingRowResult('messaging.appendElements', {
    messageId: 'm'.repeat(512),
    revision: 2,
    appliedElementIds: ['text-1'],
  }).valid, true);
  assert.equal(validateMessagingRowResult('messaging.appendElements', {
    messageId: 'm'.repeat(513),
    revision: 2,
    appliedElementIds: ['text-1'],
  }).valid, false);
});

test('beta.22 keeps the external source address on its own inline bound', () => {
  const draftWithSource = (messageId: string) => ({
    address: { kind: 'thread_handle', handle: 'thread-1' },
    idempotencyKey: 'p1-beta22',
    payload: {
      provenance: {
        epistemicStatus: 'observation',
        origin: {
          kind: 'external',
          connectorId: 'connector-1',
          sourceAddress: { connectorId: 'connector-1', chatId: 'chat-1', messageId },
        },
      },
      elements: [{ elementId: 'text-1', kind: 'text', payload: { text: 'hi' } }],
    },
  });
  assert.equal(validateMessagingRowInput('messaging.send', draftWithSource('x'.repeat(512))).valid, true);
  assert.equal(validateMessagingRowInput('messaging.send', draftWithSource('x'.repeat(513))).valid, false);
});

test('beta.22 manifest admits v2 message subscriptions and keeps the lifecycle rule', () => {
  const manifest = (contribution: Record<string, unknown>) => ({
    pluginId: 'dev.clowder.beta22',
    version: '0.1.0',
    contractVersion: '0.1.0-beta.22',
    name: 'Beta 22',
    features: [{
      id: 'messages', name: 'Messages', resources: [], capabilities: [],
      contributions: [{ type: 'message-subscription', id: 'outbound' }],
    }],
    contributions: [{
      type: 'message-subscription', id: 'outbound', binding: 'messages',
      action: { method: 'messages.deliver' },
      ...contribution,
    }],
    runtime: { transport: 'stdio', entrypoint: 'dist/index.js' },
  });

  assert.equal(validateManifest(manifest({ presentation: 'v2' })).valid, true);
  assert.equal(validateManifest(manifest({
    lifecycleAction: { method: 'messages.lifecycle' }, presentation: 'v2',
  })).valid, true);
  assert.equal(validateManifest(manifest({
    lifecycleAction: { method: 'messages.lifecycle' },
  })).valid, false);
  assert.equal(validateManifest(manifest({
    lifecycleAction: { method: 'messages.lifecycle' }, presentation: 'v3',
  })).valid, false);
  assert.equal(validateManifest(manifest({ presentation: 'v3' })).valid, false);
});
