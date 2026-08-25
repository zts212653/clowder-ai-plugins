import assert from 'node:assert/strict';
import test from 'node:test';

import { FeishuGatewayError } from './gateway.js';
import { createLarkCliFeishuEventGateway } from './lark-cli-gateway.js';

const SIGNAL = new AbortController().signal;

async function* openEvents(): AsyncGenerator<unknown> {
  await new Promise<never>(() => undefined);
}

test('falls back to the shared user-auth polling source only for an exact event-bus conflict', async () => {
  let starts = 0;
  let eventCloses = 0;
  let pollingStarts = 0;
  let pollingCloses = 0;
  const gateway = createLarkCliFeishuEventGateway({
    createConsumer: async () => {
      starts += 1;
      if (starts === 2) throw new FeishuGatewayError('EVENT_BUS_CONFLICT', 'typed conflict');
      return {
        events: openEvents(),
        close: async () => {
          eventCloses += 1;
        },
      };
    },
    createPollingGateway: () => ({
      start: async () => {
        pollingStarts += 1;
      },
      detectCatchUpRequirement: async () => undefined,
      listGeneratedArtifacts: async () => ({
        artifacts: [{
          artifactId: 'minute_shared',
          kind: 'minute',
          revision: '1786381200000',
          generatedAt: '2026-08-10T17:00:00.000Z',
        }],
        nextCursor: 'poll-v1:1786381200000',
      }),
      inspectArtifact: async () => {
        throw new Error('not used');
      },
      scanGeneratedArtifacts: async ({ throughCursor }) => ({
        artifacts: [],
        nextCursor: throughCursor,
      }),
      close: async () => {
        pollingCloses += 1;
      },
    }),
  });

  await gateway.start();
  const page = await gateway.listGeneratedArtifacts({ cursor: null, limit: 64, signal: SIGNAL });

  assert.equal(eventCloses, 1, 'partial event startup must be closed before fallback readiness');
  assert.equal(pollingStarts, 1);
  assert.equal(page.nextCursor, 'poll-v1:1786381200000');
  await gateway.close();
  assert.equal(pollingCloses, 1);
});

test('does not hide non-conflict source failures behind polling', async () => {
  let pollingStarts = 0;
  const gateway = createLarkCliFeishuEventGateway({
    createConsumer: async () => {
      throw new FeishuGatewayError('AUTH_EXPIRED', 'typed auth failure');
    },
    createPollingGateway: () => ({
      start: async () => {
        pollingStarts += 1;
      },
      detectCatchUpRequirement: async () => undefined,
      listGeneratedArtifacts: async () => ({ artifacts: [], nextCursor: null }),
      inspectArtifact: async () => {
        throw new Error('not used');
      },
      scanGeneratedArtifacts: async ({ throughCursor }) => ({
        artifacts: [],
        nextCursor: throughCursor,
      }),
      close: async () => undefined,
    }),
  });

  await assert.rejects(
    gateway.start(),
    error => error instanceof FeishuGatewayError && error.code === 'AUTH_EXPIRED',
  );
  assert.equal(pollingStarts, 0);
  await gateway.close();
});
