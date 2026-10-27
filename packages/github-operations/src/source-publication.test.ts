import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginOwnerOperationContext } from '@clowder-ai/plugin-sdk';
import { memoryStorage } from '../test/memory-storage.js';
import { createGitHubSourcePublication } from './source-publication.js';

test('GitHub source sharing requires explicit owner publication, fresh registered-repository reads and the same account', async () => {
  const storage = memoryStorage(),
    calls: string[][] = [];
  let allowed = true,
    principal = 42,
    body = 'Private issue body';
  const invoke = createGitHubSourcePublication({
    storage,
    token: async () => undefined,
    allowed: async () => allowed,
    execFileAsync: async (_file, args) => {
      calls.push(args);
      return {
        stdout: JSON.stringify(
          args[1] === 'user'
            ? { id: principal }
            : {
                number: 8,
                title: 'Private source title',
                body,
                user: { login: 'author' },
                updated_at: '2026-10-27T01:00:00Z',
                html_url: 'https://github.com/org/repo/issues/8',
                repository_url: 'https://api.github.com/repos/org/repo',
              },
        ),
      };
    },
  });
  const owner: PluginOwnerOperationContext = {
    kind: 'owner-operation',
    userId: 'local-owner',
    pluginInstanceId: 'github-instance',
    operationKey: 'sourceMaterial',
    actionId: 'invoke',
    requestId: 'owner-request',
    signal: new AbortController().signal,
    async assertCurrent() {},
  };
  const publication = {
    publicationId: 'pub-1',
    serviceInstanceId: 'svc-test',
    collectiveId: 'col-test',
    connectionId: 'con-test',
    humanId: 'human-owner',
    roadmapId: 'roadmap-test',
    channelId: 'general',
    sourceEventId: 'evt_test',
    provider: 'github',
    sourceId: 'https://github.com/org/repo/issues/8',
  };
  const read = (action: 'publish' | 'read', selected = publication) =>
    Promise.resolve(
      invoke(
        {
          input: { recoveryMode: '', operation: { action, publication: selected } },
          operationState: { currentAction: 'invoke', updatedAt: 1 },
        },
        undefined,
        owner,
      ),
    );
  assert.deepEqual(await read('read'), { render: 'status', data: { status: 'unavailable', reason: 'not_published' } });
  assert.equal(calls.length, 0);
  const first = (await read('publish')) as { data: { status: string; witness: { digest: string } } };
  assert.equal(first.data.status, 'available');
  body = 'Edited body';
  const changed = (await read('read')) as typeof first;
  assert.notEqual(changed.data.witness.digest, first.data.witness.digest);
  assert.equal(JSON.stringify(await storage.list()).includes('Private source title'), false);
  assert.equal(JSON.stringify(await storage.list()).includes('Private issue body'), false);
  principal = 77;
  assert.equal(((await read('read')) as { data: { status: string } }).data.status, 'unavailable');
  principal = 42;
  allowed = false;
  assert.equal(((await read('read')) as { data: { status: string } }).data.status, 'unavailable');
  await assert.rejects(read('read', { ...publication, channelId: 'elsewhere' }), /scope/);
  assert.ok(calls.every((args) => args[0] === 'api' && !args.includes('POST') && !args.includes('PATCH')));
});
