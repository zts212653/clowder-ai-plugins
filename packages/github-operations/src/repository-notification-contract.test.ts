import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { validateMessagingRowInput } from '@clowder-ai/plugin-contract';
import type { FeatureContext, PluginMessagingDraft, PluginStorageEntry, PluginStorageHost } from '@clowder-ai/plugin-sdk';
import { CommunityRuntime, type RepoSubject } from './community-runtime.js';
import { scanMemory } from '../test/memory-storage.js';

// Exercise the real scan/webhook adapters against the shared messaging schema.
// Only Host presentation fields are removed; unknown transport fields must fail.
function fixture() {
  const rows = new Map<string, PluginStorageEntry>();
  let revision = 0;
  const storage: PluginStorageHost = {
    get: async key => structuredClone(rows.get(key)),
    list: async () => structuredClone(Object.fromEntries(rows)),
    scan: async input => scanMemory(rows, input),
    set: async (key, value) => {
      rows.set(key, { revision: ++revision, value: structuredClone(value) });
      return { revision };
    },
    compareAndSet: async (key, expected, value) => {
      if ((rows.get(key)?.revision ?? null) !== expected) return { applied: false };
      rows.set(key, { revision: ++revision, value: structuredClone(value) });
      return { applied: true, revision };
    },
    delete: async key => ({ deleted: rows.delete(key) }),
  };
  const sent: Array<{ threadId: string; draft: PluginMessagingDraft }> = [];
  let subjects: RepoSubject[] = [];
  const context = {
    storage,
    config: { get: async () => undefined },
    secrets: { get: async () => 'fixture-webhook-secret' },
    messaging: {
      send: async (threadId: string, draft: PluginMessagingDraft) => {
        const { identity, wake, ...transport } = draft;
        assert.equal(identity, 'github-notification');
        assert.deepEqual(wake, { catId: 'guardian' });
        assert.equal(threadId, 'inbox-thread');
        const checked = validateMessagingRowInput('messaging.send', {
          ...transport, address: { kind: 'thread_handle', handle: 'fixture-thread-handle' },
        });
        assert.equal(checked.valid, true, JSON.stringify(checked));
        sent.push({ threadId, draft: structuredClone(draft) });
        return { messageId: `message-${sent.length}`, threadId };
      },
    },
    log: () => {},
  } as unknown as FeatureContext;
  const runtime = new CommunityRuntime(context, {
    listOpen: async () => structuredClone(subjects),
    repoComments: async () => [], state: async () => null, selfLogin: () => 'owner',
  });
  return { runtime, sent, setSubjects: (value: RepoSubject[]) => { subjects = value; } };
}

const repo = 'example/project';
const subject = (kind: 'pr' | 'issue', number: number): RepoSubject => ({
  kind, number, title: 'A community contribution',
  url: `https://github.com/${repo}/${kind === 'pr' ? 'pull' : 'issues'}/${number}`,
  author: 'contributor', authorAssociation: 'CONTRIBUTOR', draft: false,
});

test('repository scan delivers new PR and issue links through the messaging contract and keeps its receipts', async t => {
  const f = fixture();
  t.after(() => f.runtime.stop());
  await f.runtime.configs.upsert({ repo, guardThreadId: 'inbox-thread', guardCatId: 'guardian' });
  await f.runtime.run('repo-scan');
  assert.equal(f.sent.length, 0, 'establishing a baseline stays quiet');
  f.setSubjects([subject('pr', 12), subject('issue', 13)]);
  await f.runtime.run('repo-scan');
  assert.equal(f.sent.length, 2);
  for (const [index, kind] of (['pr', 'issue'] as const).entries()) {
    const draft = f.sent[index]!.draft;
    assert.equal(draft.idempotencyKey, `github:scan:${kind}:${repo}#${12 + index}`);
    assert.ok(JSON.stringify(draft.payload).includes(subject(kind, 12 + index).url));
  }
  await f.runtime.run('repo-scan');
  assert.equal(f.sent.length, 2, 'successful sends remain acknowledged on the next scan');
});

for (const kind of ['pr', 'issue'] as const) {
  test(`signed ${kind} webhook delivers a link through the messaging contract and suppresses replay`, async t => {
    const f = fixture();
    t.after(() => f.runtime.stop());
    await f.runtime.configs.upsert({ repo, guardThreadId: 'inbox-thread', guardCatId: 'guardian' });
    const item = subject(kind, 14);
    const body = {
      action: 'opened', repository: { full_name: repo },
      [kind === 'pr' ? 'pull_request' : 'issue']: {
        number: item.number, title: item.title, html_url: item.url,
        user: { login: item.author }, author_association: item.authorAssociation, draft: false,
      },
    };
    const rawBody = Buffer.from(JSON.stringify(body));
    const headers = {
      'x-github-event': kind === 'pr' ? 'pull_request' : 'issues',
      'x-github-delivery': `opened-${kind}`,
      'x-hub-signature-256': 'sha256=' + createHmac('sha256', 'fixture-webhook-secret').update(rawBody).digest('hex'),
    };
    const request = { method: 'POST', headers, rawBody };
    assert.equal((await f.runtime.webhook(request)).status, 200);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0]!.draft.idempotencyKey, `github:webhook:opened-${kind}`);
    assert.ok(JSON.stringify(f.sent[0]!.draft.payload).includes(item.url));
    assert.equal((await f.runtime.webhook(request)).status, 200);
    assert.equal(f.sent.length, 1, 'the same provider delivery must not be sent again');
  });
}
