import assert from 'node:assert/strict';
import test from 'node:test';

import { FeishuGatewayError } from './gateway.js';
import {
  createLarkCliFeishuPollingGateway,
  type LarkCliReadCommand,
} from './lark-cli-polling-gateway.js';

const NOW = 1_786_381_500_000;
const SIGNAL = new AbortController().signal;

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function emptySearch() {
  return { ok: true, data: { items: [], has_more: false, page_token: '' } };
}

test('readiness probes Minutes owner, Minutes participant, and VC with only user identity', async () => {
  const calls: string[][] = [];
  const gateway = createLarkCliFeishuPollingGateway({
    homeDirectory: '/Users/example',
    now: () => NOW,
    runCommand: async (args) => {
      calls.push([...args]);
      return emptySearch();
    },
  });

  await gateway.start();

  assert.equal(calls.length, 3);
  assert.ok(calls.some(args => flag(args, '--owner-ids') === 'me'));
  assert.ok(calls.some(args => flag(args, '--participant-ids') === 'me'));
  assert.ok(calls.some(args => args[0] === 'vc' && args[1] === '+search'));
  for (const args of calls) {
    assert.equal(flag(args, '--as'), 'user');
    assert.equal(flag(args, '--page-size'), '1');
    assert.equal(flag(args, '--start'), new Date(NOW - 1_000).toISOString());
    assert.equal(flag(args, '--end'), new Date(NOW).toISOString());
  }
  await gateway.close();
});

test('polls owner and participant Minutes plus VC details, paginates, and deduplicates artifacts', async () => {
  const calls: string[][] = [];
  const runCommand: LarkCliReadCommand = async (args) => {
    calls.push([...args]);
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
          items: [{ id: 'meeting_1', display_info: 'F292 dogfood' }],
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
        artifactId: 'note_1',
        kind: 'note',
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
    ],
    nextCursor: `poll-v1:${NOW}`,
  });
  const searches = calls.filter(args => args[1] === '+search' && flag(args, '--page-size') === '30');
  assert.equal(searches.length, 4, 'owner pagination plus participant and VC search');
  for (const args of calls) assert.equal(flag(args, '--as'), 'user');
  assert.equal(flag(searches[0], '--start'), new Date(NOW - 5 * 60_000).toISOString());
  assert.equal(flag(searches[0], '--end'), new Date(NOW).toISOString());
  await gateway.close();
});

test('uses a bounded overlap for stored cursors and cadence-blocks an empty poll', async () => {
  const calls: string[][] = [];
  let sleeps = 0;
  const gateway = createLarkCliFeishuPollingGateway({
    homeDirectory: '/Users/example',
    now: () => NOW,
    runCommand: async (args) => {
      calls.push([...args]);
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

  assert.deepEqual(page, { artifacts: [], nextCursor: `poll-v1:${NOW}` });
  assert.equal(sleeps, 1);
  const poll = calls.find(args => flag(args, '--page-size') === '30');
  assert.ok(poll);
  assert.equal(flag(poll, '--start'), new Date(NOW - 90_000).toISOString());
  await gateway.close();
});

test('fails closed on malformed read responses without converting them to empty pages', async () => {
  const gateway = createLarkCliFeishuPollingGateway({
    homeDirectory: '/Users/example',
    now: () => NOW,
    runCommand: async (args) => flag(args, '--page-size') === '1'
      ? emptySearch()
      : { ok: true, data: { items: 'not-an-array' } },
  });

  await assert.rejects(
    gateway.listGeneratedArtifacts({ cursor: null, limit: 64, signal: SIGNAL }),
    error => error instanceof FeishuGatewayError && error.code === 'UNAVAILABLE',
  );
  await gateway.close();
});
