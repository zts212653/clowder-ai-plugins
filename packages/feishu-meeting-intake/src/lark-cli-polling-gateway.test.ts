import assert from 'node:assert/strict';
import test from 'node:test';

import { FeishuCatchUpRequiredError, FeishuGatewayError } from './gateway.js';
import {
  createLarkCliFeishuPollingGateway,
  type LarkCliReadCommand,
} from './lark-cli-polling-gateway.js';

const NOW = 1_786_381_500_000;
const SIGNAL = new AbortController().signal;
const CONSISTENCY_LAG_MS = 10 * 60_000;

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

test('readiness verifies detail scopes and probes Minutes owner, participant, and VC as user', async () => {
  const calls: string[][] = [];
  const gateway = createLarkCliFeishuPollingGateway({
    homeDirectory: '/Users/example',
    now: () => NOW,
    runCommand: async (args) => {
      calls.push([...args]);
      if (args[0] === 'auth') return validAuthStatus();
      return emptySearch();
    },
  });

  await gateway.start();

  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0], ['auth', 'status', '--json', '--verify']);
  const probes = calls.slice(1);
  assert.ok(probes.some(args => flag(args, '--owner-ids') === 'me'));
  assert.ok(probes.some(args => flag(args, '--participant-ids') === 'me'));
  assert.ok(probes.some(args => args[0] === 'vc' && args[1] === '+search'));
  for (const args of probes) {
    assert.equal(flag(args, '--as'), 'user');
    assert.equal(flag(args, '--page-size'), '1');
    assert.equal(flag(args, '--start'), new Date(NOW - 1_000).toISOString());
    assert.equal(flag(args, '--end'), new Date(NOW).toISOString());
  }
  await gateway.close();
});

test('readiness fails closed before search when a required detail scope is absent', async () => {
  const calls: string[][] = [];
  const status = validAuthStatus();
  status.identities.user.scope = status.identities.user.scope.replace('vc:record:readonly', '');
  const gateway = createLarkCliFeishuPollingGateway({
    homeDirectory: '/Users/example',
    now: () => NOW,
    runCommand: async (args) => {
      calls.push([...args]);
      return status;
    },
  });

  await assert.rejects(
    gateway.start(),
    error => error instanceof FeishuGatewayError && error.code === 'PERMISSION_DENIED',
  );
  assert.deepEqual(calls, [['auth', 'status', '--json', '--verify']]);
  await gateway.close();
});

test('polls owner and participant Minutes plus VC details, paginates, and deduplicates artifacts', async () => {
  const calls: string[][] = [];
  const runCommand: LarkCliReadCommand = async (args) => {
    calls.push([...args]);
    if (args[0] === 'auth') return validAuthStatus();
    if (flag(args, '--page-size') === '1') return emptySearch();
    if (args[0] === 'minutes' && args[1] === '+search') {
      if (flag(args, '--participant-ids') === 'me') {
        return {
          ok: true,
          data: {
            items: [{ token: 'minute_1', display_info: 'duplicate' }],
            has_more: false,
            page_token: '',
          },
        };
      }
      if (flag(args, '--page-token') === 'minutes-next') {
        return {
          ok: true,
          data: {
            items: [{ token: 'minute_2', display_info: 'Second minute' }],
            has_more: false,
            page_token: '',
          },
        };
      }
      return {
        ok: true,
        data: {
          items: [{ token: 'minute_1', display_info: 'First minute' }],
          has_more: true,
          page_token: 'minutes-next',
        },
      };
    }
    if (args[0] === 'vc' && args[1] === '+search') {
      return {
        ok: true,
        data: {
          items: [
            { id: 'meeting_1', display_info: 'F292 dogfood' },
            { id: 'meeting_2', display_info: 'Note-only fallback' },
          ],
          has_more: false,
          page_token: '',
        },
      };
    }
    if (args[0] === 'vc' && args[1] === '+detail') {
      return {
        ok: true,
        data: {
          meetings: [{
            meeting_id: 'meeting_1',
            topic: 'F292 dogfood',
            start_time: '2026-08-10T16:30:00.000Z',
            end_time: '2026-08-10T17:00:00.000Z',
            note_id: 'note_1',
            minute_token: 'minute_1',
          }, {
            meeting_id: 'meeting_2',
            topic: 'Note-only fallback',
            start_time: '2026-08-10T18:30:00.000Z',
            end_time: '2026-08-10T19:00:00.000Z',
            note_id: 'note_2',
          }],
        },
      };
    }
    if (args[0] === 'minutes' && args[1] === 'minutes') {
      const token = flag(args, '--minute-token');
      return {
        ok: true,
        data: {
          minute: {
            token,
            create_time: token === 'minute_1' ? '1786381200000' : '1786381201000',
            title: token === 'minute_1' ? 'F292 dogfood' : 'Second minute',
            note_id: token === 'minute_1' ? 'note_1' : '',
          },
        },
      };
    }
    throw new Error(`unexpected command: ${args.join(' ')}`);
  };
  const gateway = createLarkCliFeishuPollingGateway({
    homeDirectory: '/Users/example',
    now: () => NOW,
    runCommand,
  });

  const page = await gateway.listGeneratedArtifacts({ cursor: null, limit: 64, signal: SIGNAL });

  assert.deepEqual(page, {
    artifacts: [
      {
        artifactId: 'minute_1',
        kind: 'minute',
        revision: '1786381200000',
        generatedAt: '2026-08-10T17:00:00.000Z',
        title: 'F292 dogfood',
        meetingId: 'meeting_1',
      },
      {
        artifactId: 'minute_2',
        kind: 'minute',
        revision: '1786381201000',
        generatedAt: '2026-08-10T17:00:01.000Z',
        title: 'Second minute',
      },
      {
        artifactId: 'note_2',
        kind: 'note',
        revision: '1786388400000',
        generatedAt: '2026-08-10T19:00:00.000Z',
        title: 'Note-only fallback',
        meetingId: 'meeting_2',
      },
    ],
    nextCursor: `poll-v1:${NOW - CONSISTENCY_LAG_MS}`,
  });
  const searches = calls.filter(args => args[1] === '+search' && flag(args, '--page-size') === '30');
  assert.equal(searches.length, 4, 'owner pagination plus participant and VC search');
  for (const args of calls.filter(args => args[0] !== 'auth')) {
    assert.equal(flag(args, '--as'), 'user');
  }
  assert.equal(
    flag(searches[0], '--start'),
    new Date(NOW - CONSISTENCY_LAG_MS - 5 * 60_000).toISOString(),
  );
  assert.equal(flag(searches[0], '--end'), new Date(NOW - CONSISTENCY_LAG_MS).toISOString());
  await gateway.close();
});

test('pairs a discovered Minute to VC note identity before minute_token becomes visible', async () => {
  const runCommand: LarkCliReadCommand = async (args) => {
    if (args[0] === 'auth') return validAuthStatus();
    if (flag(args, '--page-size') === '1') return emptySearch();
    if (args[0] === 'minutes' && args[1] === '+search') {
      return flag(args, '--owner-ids') === 'me'
        ? {
            ok: true,
            data: {
              items: [{ token: 'minute_1' }],
              has_more: false,
              page_token: '',
            },
          }
        : emptySearch();
    }
    if (args[0] === 'vc' && args[1] === '+search') {
      return {
        ok: true,
        data: {
          items: [{ id: 'meeting_1' }, { id: 'meeting_2' }],
          has_more: false,
          page_token: '',
        },
      };
    }
    if (args[0] === 'vc' && args[1] === '+detail') {
      return {
        ok: true,
        data: {
          meetings: [{
            meeting_id: 'meeting_1',
            topic: 'Delayed Minute association',
            start_time: '2026-08-10T16:30:00.000Z',
            end_time: '2026-08-10T17:00:00.000Z',
            note_id: 'note_1',
          }, {
            meeting_id: 'meeting_2',
            topic: 'Independent Note-only meeting',
            start_time: '2026-08-10T17:30:00.000Z',
            end_time: '2026-08-10T18:00:00.000Z',
            note_id: 'note_2',
          }],
        },
      };
    }
    if (args[0] === 'minutes' && args[1] === 'minutes') {
      return {
        ok: true,
        data: {
          minute: {
            token: 'minute_1',
            create_time: '1786381500000',
            title: 'Delayed Minute association',
            note_id: 'note_1',
          },
        },
      };
    }
    throw new Error(`unexpected command: ${args.join(' ')}`);
  };
  const gateway = createLarkCliFeishuPollingGateway({
    homeDirectory: '/Users/example',
    now: () => NOW,
    runCommand,
  });

  const page = await gateway.listGeneratedArtifacts({ cursor: null, limit: 64, signal: SIGNAL });

  assert.deepEqual(page.artifacts, [
    {
      artifactId: 'minute_1',
      kind: 'minute',
      revision: '1786381500000',
      generatedAt: '2026-08-10T17:05:00.000Z',
      title: 'Delayed Minute association',
      meetingId: 'meeting_1',
    },
    {
      artifactId: 'note_2',
      kind: 'note',
      revision: '1786384800000',
      generatedAt: '2026-08-10T18:00:00.000Z',
      title: 'Independent Note-only meeting',
      meetingId: 'meeting_2',
    },
  ]);
  await gateway.close();
});

test('never advances a stored cursor beyond the bounded Feishu search-consistency horizon', async () => {
  const calls: string[][] = [];
  let sleeps = 0;
  const gateway = createLarkCliFeishuPollingGateway({
    homeDirectory: '/Users/example',
    now: () => NOW,
    runCommand: async (args) => {
      calls.push([...args]);
      if (args[0] === 'auth') return validAuthStatus();
      return emptySearch();
    },
    sleep: async () => {
      sleeps += 1;
    },
  });

  const page = await gateway.listGeneratedArtifacts({
    cursor: `poll-v1:${NOW - 60_000}`,
    limit: 64,
    signal: SIGNAL,
  });

  assert.deepEqual(page, {
    artifacts: [],
    nextCursor: `poll-v1:${NOW - CONSISTENCY_LAG_MS}`,
  });
  assert.equal(sleeps, 1);
  const poll = calls.find(args => flag(args, '--page-size') === '30');
  assert.ok(poll);
  assert.equal(
    flag(poll, '--start'),
    new Date(NOW - CONSISTENCY_LAG_MS - 30_000).toISOString(),
  );
  assert.equal(flag(poll, '--end'), new Date(NOW - CONSISTENCY_LAG_MS).toISOString());
  await gateway.close();
});

test('freezes an offline cursor gap for owner recovery instead of silently scanning or skipping it', async () => {
  const calls: string[][] = [];
  const fromCursor = `poll-v1:${NOW - 2 * 60 * 60_000}`;
  const gateway = createLarkCliFeishuPollingGateway({
    homeDirectory: '/Users/example',
    now: () => NOW,
    maxAutomaticCatchUpMs: 60 * 60_000,
    runCommand: async (args) => {
      calls.push([...args]);
      if (args[0] === 'auth') return validAuthStatus();
      return emptySearch();
    },
  });

  await assert.rejects(
    gateway.listGeneratedArtifacts({ cursor: fromCursor, limit: 64, signal: SIGNAL }),
    error => error instanceof FeishuCatchUpRequiredError &&
      error.reason === 'CURSOR_GAP' &&
      error.fromCursor === fromCursor &&
      error.throughCursor === `poll-v1:${NOW - CONSISTENCY_LAG_MS}`,
  );
  assert.equal(calls.filter(args => flag(args, '--page-size') === '30').length, 0);
  await gateway.close();
});

test('detects an offline cursor gap before starting the disabled source runtime', async () => {
  const calls: string[][] = [];
  const fromCursor = `poll-v1:${NOW - 2 * 60 * 60_000}`;
  const gateway = createLarkCliFeishuPollingGateway({
    homeDirectory: '/Users/example',
    now: () => NOW,
    maxAutomaticCatchUpMs: 60 * 60_000,
    runCommand: async (args) => {
      calls.push([...args]);
      return args[0] === 'auth' ? validAuthStatus() : emptySearch();
    },
  });

  await assert.rejects(
    gateway.detectCatchUpRequirement({
      cursor: fromCursor,
      lastSuccessfulObservationAt: null,
      signal: SIGNAL,
    }),
    error => error instanceof FeishuCatchUpRequiredError &&
      error.fromCursor === fromCursor &&
      error.throughCursor === `poll-v1:${NOW - CONSISTENCY_LAG_MS}`,
  );
  assert.deepEqual(calls, []);
  await gateway.close();
});

test('uses the last durable observation when an event cursor falls back to polling', async () => {
  const gateway = createLarkCliFeishuPollingGateway({
    homeDirectory: '/Users/example',
    now: () => NOW,
    maxAutomaticCatchUpMs: 60 * 60_000,
    runCommand: async (args) => args[0] === 'auth' ? validAuthStatus() : emptySearch(),
  });

  await assert.rejects(
    gateway.listGeneratedArtifacts({
      cursor: 'event-v1:opaque',
      lastSuccessfulObservationAt: NOW - 2 * 60 * 60_000,
      limit: 64,
      signal: SIGNAL,
    }),
    error => error instanceof FeishuCatchUpRequiredError &&
      error.fromCursor === `poll-v1:${NOW - 2 * 60 * 60_000}`,
  );
  await gateway.close();
});

test('retains a caller-configured search-consistency horizon without widening the scan unboundedly', async () => {
  const calls: string[][] = [];
  const gateway = createLarkCliFeishuPollingGateway({
    homeDirectory: '/Users/example',
    now: () => NOW,
    searchConsistencyLagMs: 2 * 60_000,
    runCommand: async (args) => {
      calls.push([...args]);
      if (args[0] === 'auth') return validAuthStatus();
      return emptySearch();
    },
    sleep: async () => undefined,
  });

  const page = await gateway.listGeneratedArtifacts({
    cursor: `poll-v1:${NOW - 5 * 60_000}`,
    limit: 64,
    signal: SIGNAL,
  });

  assert.equal(page.nextCursor, `poll-v1:${NOW - 2 * 60_000}`);
  const poll = calls.find(args => flag(args, '--page-size') === '30');
  assert.ok(poll);
  assert.equal(flag(poll, '--start'), new Date(NOW - 5 * 60_000 - 30_000).toISOString());
  assert.equal(flag(poll, '--end'), new Date(NOW - 2 * 60_000).toISOString());
  await gateway.close();
});

test('fails closed on malformed read responses without converting them to empty pages', async () => {
  const gateway = createLarkCliFeishuPollingGateway({
    homeDirectory: '/Users/example',
    now: () => NOW,
    runCommand: async (args) => {
      if (args[0] === 'auth') return validAuthStatus();
      return flag(args, '--page-size') === '1'
        ? emptySearch()
        : { ok: true, data: { items: 'not-an-array' } };
    },
  });

  await assert.rejects(
    gateway.listGeneratedArtifacts({ cursor: null, limit: 64, signal: SIGNAL }),
    error => error instanceof FeishuGatewayError && error.code === 'UNAVAILABLE',
  );
  await gateway.close();
});
