import assert from 'node:assert/strict';
import test from 'node:test';
import { collectLegacyGitHubSource, type LegacyReadPort } from './operational-source.js';

test('the operational reader freezes selected legacy Redis state without store migrations or content reads', async () => {
  const calls: Array<[string, ...string[]]> = [];
  const prefix = 'isolated:';
  const task = {
    id: 'old-pr',
    kind: 'pr_tracking',
    threadId: 'thread',
    userId: 'owner',
    subjectKey: 'pr:example/project#12',
    ownerCatId: 'cat',
    title: 'Original task',
    why: 'Original continuation',
    createdBy: 'historical',
    createdAt: '1',
    updatedAt: '2',
    status: 'doing',
    automationState: JSON.stringify({
      await: {
        v: 1,
        generation: 27,
        subjectRef: 'pr:example/project#12',
        ownerFence: { kind: 'containing_task', generation: 27 },
        baseline: { capturedAt: 1, headSha: 'old' },
        continuation: { when: [{ kind: 'pr_head_changed' }], then: 'Continue' },
        createdAt: 1,
      },
    }),
    typedWaitRegistration: 'MUST NEVER READ OLD AUTHORITY',
  };
  const hashes: Record<string, Record<string, string>> = {
    [prefix + 'task:old-pr']: task,
    [prefix + 'thread:thread']: { createdBy: 'owner' },
    [prefix + 'thread:original-inbox']: { createdBy: 'owner' },
    [prefix + 'connector-binding:github-repo-event:example/project']: {
      connectorId: 'github-repo-event',
      externalChatId: 'example/project',
      threadId: 'original-inbox',
      userId: 'owner',
    },
    [prefix + 'community:repo-config:example/project']: {
      repo: 'example/project',
      guardThreadId: 'thread',
      guardCatId: 'cat',
      reviewMode: 'observe_only',
      cloudReviewPolicy: 'optional',
      createdAt: '1',
      updatedAt: '2',
    },
  };
  const strings: Record<string, string> = {
    [prefix + 'f141:baseline:example/project']: '1',
    [prefix + 'f141:notified:example/project#pr-12']: '1',
    [prefix + 'community:repo-comment:cursor:example/project']: '2026-10-21T00:00:00.000Z',
  };
  const port: LegacyReadPort = {
    async read(command, ...args) {
      calls.push([command, ...args]);
      const h = hashes[args[0]!] ?? {};
      switch (command) {
        case 'ZCARD':
          return args[0] === prefix + 'tasks:kind:pr_tracking' ? 1 : 0;
        case 'ZRANGE':
          return args[0] === prefix + 'tasks:kind:pr_tracking' ? ['old-pr'] : [];
        case 'SCARD':
          return args[0] === prefix + 'community:repo-configs:index' ? 1 : 0;
        case 'SMEMBERS':
          return ['example/project'];
        case 'HGET':
          return h[args[1]!] ?? null;
        case 'HMGET':
          return args.slice(1).map((f) => h[f] ?? null);
        case 'HEXISTS':
          return args[1] === 'typedWaitRegistration' ? 1 : 0;
        case 'HSTRLEN':
          return (h[args[1]!] ?? '').length;
        case 'GET':
          return strings[args[0]!] ?? null;
        case 'SCAN':
          return ['0', args[2]!.includes('f141:notified') ? [prefix + 'f141:notified:example/project#pr-12'] : []];
        case 'SSCAN':
          return ['0', ['comment:example/project#42:23']];
        default:
          throw new Error('Unexpected command ' + command);
      }
    },
  };
  const result = await collectLegacyGitHubSource(
    port,
    {
      ownerUserId: 'owner',
      keyPrefix: prefix,
      repositories: ['example/project'],
      excludedTaskIds: ['parent-work'],
      sourceRef: 'isolated:source',
      oldWriterProofRef: 'isolated:no-writer',
    },
    new AbortController().signal,
  );
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0]?.automationState?.await?.generation, 27);
  assert.equal(result.repositories[0]?.config.guardThreadId, 'thread');
  assert.deepEqual(result.repositories[0]?.notificationRoute, { threadId: 'original-inbox', userId: 'owner' });
  assert.deepEqual(result.repositories[0]?.commentOverlapEventIds, ['comment:example/project#42:23']);
  assert.equal(result.repositories[0]?.progress['f141:notified:example/project#pr-12'], '1');
  assert.ok(result.retainedAuthorityRefs.some((ref) => ref.includes('typedWaitRegistration')));
  assert.ok(!JSON.stringify(result).includes('MUST NEVER READ'));
  assert.ok(calls.every(([c]) => !['SET', 'HSET', 'EVAL', 'MULTI', 'HGETALL', 'KEYS', 'DUMP', 'SAVE'].includes(c)));
  assert.ok(
    calls
      .filter(([c]) => c === 'HMGET' || c === 'HGET')
      .every((call) => !call.includes('content') && !call.includes('typedWaitRegistration')),
  );
  hashes[prefix + 'thread:original-inbox']!.createdBy = 'another-owner';
  await assert.rejects(collectLegacyGitHubSource(port, {
    ownerUserId: 'owner', keyPrefix: prefix, repositories: ['example/project'], excludedTaskIds: ['parent-work'],
    sourceRef: 'isolated:source', oldWriterProofRef: 'isolated:no-writer',
  }, new AbortController().signal), /route binding.*owner scope/);
});
