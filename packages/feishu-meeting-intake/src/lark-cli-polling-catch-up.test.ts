import assert from 'node:assert/strict';
import test from 'node:test';

import { FeishuCatchUpRequiredError } from './gateway.js';
import { createLarkCliFeishuPollingGateway } from './lark-cli-polling-gateway.js';

const NOW = 1_786_381_500_000;
const SIGNAL = new AbortController().signal;

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function emptySearch() {
  return { ok: true, data: { items: [], has_more: false, page_token: '' } };
}

function validAuthStatus() {
  return {
    verified: true,
    identities: {
      user: {
        scope: [
          'minutes:minutes.search:read',
          'minutes:minutes.basic:read',
          'vc:meeting.search:read',
          'vc:meeting.meetingevent:read',
          'vc:record:readonly',
        ].join(' '),
      },
    },
  };
}

test('recovery scanner reads the exact frozen window without the automatic-gap shortcut', async () => {
  const calls: string[][] = [];
  const gateway = createLarkCliFeishuPollingGateway({
    homeDirectory: '/Users/example',
    now: () => NOW,
    maxAutomaticCatchUpMs: 60_000,
    runCommand: async (args) => {
      calls.push([...args]);
      return args[0] === 'auth' ? validAuthStatus() : emptySearch();
    },
  });
  const fromCursor = `poll-v1:${NOW - 2 * 60 * 60_000}`;
  const throughCursor = `poll-v1:${NOW - 10 * 60_000}`;

  const page = await gateway.scanGeneratedArtifacts({ fromCursor, throughCursor, signal: SIGNAL });

  assert.deepEqual(page, { artifacts: [], nextCursor: throughCursor });
  const searches = calls.filter(args => flag(args, '--page-size') === '30');
  assert.equal(searches.length, 3);
  assert.equal(
    flag(searches[0], '--start'),
    new Date(NOW - 2 * 60 * 60_000 - 30_000).toISOString(),
  );
  assert.equal(flag(searches[0], '--end'), new Date(NOW - 10 * 60_000).toISOString());
  await gateway.close();
});

test('recovery scanner exposes page overflow as a typed durable-backlog reason', async () => {
  const gateway = createLarkCliFeishuPollingGateway({
    homeDirectory: '/Users/example',
    now: () => NOW,
    runCommand: async (args) => {
      if (args[0] === 'auth') return validAuthStatus();
      if (flag(args, '--page-size') === '1') return emptySearch();
      return {
        ok: true,
        data: {
          items: [],
          has_more: true,
          page_token: `next-${flag(args, '--page-token') ?? 'first'}`,
        },
      };
    },
  });
  const fromCursor = `poll-v1:${NOW - 20 * 60_000}`;
  const throughCursor = `poll-v1:${NOW - 10 * 60_000}`;

  await assert.rejects(
    gateway.scanGeneratedArtifacts({ fromCursor, throughCursor, signal: SIGNAL }),
    error => error instanceof FeishuCatchUpRequiredError &&
      error.reason === 'PAGE_BOUND' &&
      error.candidateCountAtLeast === 121,
  );
  await gateway.close();
});
