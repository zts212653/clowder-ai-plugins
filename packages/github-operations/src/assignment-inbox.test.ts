import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginMessagingDraft } from '@clowder-ai/plugin-sdk';
import { memoryStorage } from '../test/memory-storage.js';
import { GitHubAssignmentInbox, type AssignedIssue, type AssignmentContext, type AssignmentProvider } from './assignment-inbox.js';

function fixture() {
  const config = new Map<string, unknown>(Object.entries({ receiveAssignedIssues: true, assignmentRepositories: 'owner/project', assignmentThreadId: 'inbox', assignmentCatId: 'coordinator' }));
  const storage = memoryStorage();
  const state = { issue: { repo: 'owner/project', number: 1, id: 'I_1', title: 'test issue', state: 'open', assignees: ['owner'], assignmentId: '100' } as AssignedIssue,
    login: 'owner', readError: false, uncertainSend: false, calls: 0, beforeCurrent: undefined as (() => void) | undefined };
  const delivered = new Map<string, { thread: string; draft: PluginMessagingDraft }>();
  const attempts: string[] = [];
  const provider: AssignmentProvider = {
    async identity(signal) { signal.throwIfAborted(); state.calls++; return state.login; },
    async assigned(_repo, login, signal) { signal.throwIfAborted(); if (state.readError) throw new Error('GitHub page failed'); return state.issue.state === 'open' && state.issue.assignees.includes(login) ? [structuredClone(state.issue)] : []; },
    async current(_repo, _number, _login, signal) { signal.throwIfAborted(); state.beforeCurrent?.(); return structuredClone(state.issue); },
  };
  const context = { config: { get: async (key: string) => config.get(key) }, storage,
    threads: { get: async () => { throw new Error('thread.readContent not granted'); },
      getCats: async () => ({ participants: [], routableNow: [{ catId: config.get('assignmentCatId'), displayName: 'Coordinator', aliases: [] }], routableNotJoined: [], notRoutable: [] }) },
    messaging: { send: async (thread: string, draft: PluginMessagingDraft) => {
      const key = draft.idempotencyKey!; attempts.push(key); delivered.set(key, { thread, draft });
      if (state.uncertainSend) { state.uncertainSend = false; throw new Error('response lost after Host admission'); }
      return { messageId: `message-${key}`, threadId: thread };
    } },
  } as unknown as AssignmentContext;
  return { config, storage, state, delivered, attempts, provider, context, runtime: () => new GitHubAssignmentInbox(context, provider) };
}
const textOf = (f: ReturnType<typeof fixture>) => JSON.stringify([...f.delivered.values()]);

test('first sync delivers an existing native GitHub assignment without Issue Workbench state', async () => {
  const f = fixture(); await f.runtime().poll();
  assert.equal(f.delivered.size, 1);
  assert.match(textOf(f), /owner\/project/); assert.match(textOf(f), /认领/);
  assert.match(textOf(f), /co-creator/); assert.match(textOf(f), /授权/);
  assert.doesNotMatch(textOf(f), /issue_team_|issue-workbench\.dispatch/);
  assert.equal([...f.delivered.values()][0].thread, 'inbox');
  assert.deepEqual([...f.delivered.values()][0].draft.wake, { catId: 'coordinator' });
});

test('repeat, concurrent ticks and a fresh runtime preserve one notification', async () => {
  const f = fixture(), r = f.runtime(); await Promise.all([r.poll(), r.poll()]); await r.stop(); await f.runtime().poll();
  assert.equal(f.delivered.size, 1); assert.equal(f.attempts.length, 1);
});

for (const login of ['alice_acme', 'owner']) {
  test(`inbox preserves claim and cancellation across restart for ${login} with a managed-user co-assignee`, async () => {
    const f = fixture(); f.state.login = login;
    f.state.issue.assignees = [login, 'octo_admin'];
    const first = f.runtime(); await first.poll(); await first.stop();
    const resumed = f.runtime(); await resumed.poll();
    assert.equal(f.delivered.size, 1); assert.equal(f.attempts.length, 1);
    assert.match(textOf(f), new RegExp(`@${login}`));
    f.state.issue.assignees = ['octo_admin']; f.state.issue.assignmentId = null;
    await resumed.poll(); await resumed.poll();
    assert.equal(f.delivered.size, 2); assert.match(textOf(f), /取消认领/);
    f.state.issue.assignees = [login, 'octo_admin']; f.state.issue.assignmentId = '102';
    await resumed.poll(); assert.equal(f.delivered.size, 3);
    await resumed.stop();
  });
}

test('lost response retries the same Host idempotency key after restart', async () => {
  const f = fixture(); f.state.uncertainSend = true;
  await assert.rejects(f.runtime().poll(), /response lost/); await f.runtime().poll();
  assert.equal(f.delivered.size, 1); assert.equal(f.attempts.length, 2); assert.equal(f.attempts[0], f.attempts[1]);
});

test('native unassignment and later reclaim notify separately, keeping history', async () => {
  const f = fixture(), r = f.runtime(); await r.poll();
  f.state.issue.assignees = []; f.state.issue.assignmentId = null; await r.poll(); await r.poll();
  assert.equal(f.delivered.size, 2); assert.match(textOf(f), /取消认领/);
  f.state.issue.assignees = ['owner']; f.state.issue.assignmentId = '102'; await r.poll();
  assert.equal(f.delivered.size, 3);
});

test('closed then reopened Issue with the same assignment event is a new active period', async () => {
  const f = fixture(), r = f.runtime(); await r.poll(); f.state.issue.state = 'closed'; await r.poll();
  assert.equal(f.delivered.size, 2); assert.match(textOf(f), /关闭/);
  f.state.issue.state = 'open'; await r.poll(); assert.equal(f.delivered.size, 3);
});

test('incomplete source reads never manufacture a withdrawal', async () => {
  const f = fixture(), r = f.runtime(); await r.poll(); f.state.readError = true;
  await assert.rejects(r.poll(), /page failed/); assert.equal(f.delivered.size, 1);
  f.state.readError = false; await r.poll(); assert.equal(f.delivered.size, 1);
});

test('unassignment between listing and delivery prevents a stale claim wake', async () => {
  const f = fixture(); f.state.beforeCurrent = () => { f.state.issue.assignees = []; f.state.issue.assignmentId = null; };
  await f.runtime().poll(); assert.equal(f.delivered.size, 0);
});

test('disabled collection does not read GitHub; account changes do not withdraw another account work', async () => {
  const f = fixture(), r = f.runtime(); f.config.set('receiveAssignedIssues', false); await r.poll(); assert.equal(f.state.calls, 0);
  f.config.set('receiveAssignedIssues', true); await r.poll(); f.state.login = 'another'; await r.poll(); assert.equal(f.delivered.size, 1);
});

test('configuration changing during source validation cannot redirect a pending delivery', async () => {
  const f = fixture(); f.state.beforeCurrent = () => { f.config.set('assignmentThreadId', 'different'); };
  await assert.rejects(f.runtime().poll(), /configuration changed/); assert.equal(f.delivered.size, 0);
  f.state.beforeCurrent = undefined; f.config.set('assignmentThreadId', 'inbox'); await f.runtime().poll(); assert.equal(f.delivered.size, 1);
});

test('a newly configured destination gets its own current-claim catch-up, while old delivery stays deduplicated', async () => {
  const f = fixture(), r = f.runtime(); await r.poll();
  f.config.set('assignmentThreadId', 'new-inbox'); await r.poll();
  assert.deepEqual([...f.delivered.values()].map(v => v.thread), ['inbox', 'new-inbox']);
  f.config.set('assignmentThreadId', 'inbox'); await r.poll(); assert.equal(f.delivered.size, 2);
});

test('settled inactive history does not keep rereading inaccessible old issues', async () => {
  const f = fixture(), r = f.runtime(); await r.poll();
  f.state.issue.assignees = []; f.state.issue.assignmentId = null; await r.poll();
  f.state.beforeCurrent = () => { throw new Error('old issue deleted'); };
  await r.poll(); assert.equal(f.delivered.size, 2);
});
