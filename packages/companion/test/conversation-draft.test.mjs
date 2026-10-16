import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HostConversationDraft } from '../src/conversation-draft.mjs';

const scopeA = 'scope_A';
const scopeB = 'scope_B';
const clientId = '11111111-1111-4111-8111-111111111111';
const available = (overrides = {}) => ({
  kind: 'conversation-draft', v: 1, status: 'available', scopeRef: scopeA,
  revision: 3, text: '', writable: true, submissions: [], ...overrides,
});
const unconfirmed = (overrides = {}) => ({
  kind: 'delivery', v: 2, delivery: 'unconfirmed', clientMessageId: clientId,
  messageId: null, callId: null, ...overrides,
});
const accepted = (overrides = {}) => ({
  kind: 'delivery', v: 2, delivery: 'accepted', clientMessageId: clientId,
  messageId: 'message-a', callId: null, ...overrides,
});

function fixture(reads = [available()]) {
  const calls = [];
  const deliveries = [];
  const invalidated = [];
  let readIndex = 0;
  const client = {
    async readConversationDraft() {
      calls.push(['read']);
      return reads[Math.min(readIndex++, reads.length - 1)];
    },
    async saveConversationDraft(revision, text, scopeRef) {
      calls.push(['save', revision, text, scopeRef]);
      return available({ revision: revision + 1, text, scopeRef });
    },
    async submitConversationText(text, id, revision, scopeRef) {
      calls.push(['submit', text, id, revision, scopeRef]);
      return accepted({ clientMessageId: id });
    },
    async readConversationDelivery(id, scopeRef) {
      calls.push(['delivery-read', id, scopeRef]);
      return unconfirmed({ clientMessageId: id });
    },
  };
  const draft = new HostConversationDraft({
    client,
    uuid: () => clientId,
    changed() {},
    delivery: value => deliveries.push(structuredClone(value)),
    invalidated: value => invalidated.push(structuredClone(value)),
  });
  return { calls, client, deliveries, draft, invalidated };
}

test('read restores Host canonical text and reconciles without sending', async () => {
  const submission = {
    clientMessageId: clientId, text: '未确认输入', submissionRevision: 2,
    receipt: unconfirmed(),
  };
  const f = fixture([available({ text: '保存的草稿', submissions: [submission] })]);
  f.client.readConversationDelivery = async (id, scopeRef) => {
    f.calls.push(['delivery-read', id, scopeRef]);
    return accepted({ clientMessageId: id });
  };

  await f.draft.load();

  assert.equal(f.draft.snapshot().localText, '保存的草稿');
  assert.deepEqual(f.calls, [['read'], ['delivery-read', clientId, scopeA]]);
  assert.equal(f.calls.some(call => call[0] === 'submit'), false, 'a read must never auto-resend');
  assert.equal(f.deliveries.at(-1).receipt.delivery, 'accepted');
  assert.equal(f.deliveries.at(-1).submissionRevision, 2);
});

test('new submission saves the exact draft revision before using text v2', async () => {
  const f = fixture([available({ revision: 4 })]);
  await f.draft.load();
  f.draft.update('请继续');
  const result = await f.draft.submit();

  assert.equal(result.delivery, 'accepted');
  assert.deepEqual(f.calls.slice(0, 3), [
    ['read'],
    ['save', 4, '请继续', scopeA],
    ['submit', '请继续', clientId, 5, scopeA],
  ]);
  assert.equal(f.draft.snapshot().localText, '', 'accepted clears only the unchanged local edit');
});

test('an explicit retry preserves text, identity, revision and scope', async () => {
  const submission = {
    clientMessageId: clientId, text: '同一封信', submissionRevision: 2,
    receipt: unconfirmed(),
  };
  const f = fixture([available({ text: '后来写的新草稿', submissions: [submission] })]);
  f.client.readConversationDelivery = async (id, scopeRef) => {
    f.calls.push(['delivery-read', id, scopeRef]);
    return unconfirmed({ clientMessageId: id });
  };
  await f.draft.load();
  await f.draft.retry(submission);

  assert.deepEqual(f.calls.find(call => call[0] === 'submit'),
    ['submit', '同一封信', clientId, 2, scopeA]);
  assert.equal(f.draft.snapshot().localText, '后来写的新草稿');
});

test('CAS conflict re-reads canonical truth while preserving the local edit separately', async () => {
  const f = fixture([
    available({ revision: 4, text: '原稿' }),
    available({ revision: 5, text: '别处更新的稿' }),
  ]);
  f.client.saveConversationDraft = async (revision, text, scopeRef) => {
    f.calls.push(['save', revision, text, scopeRef]);
    return { kind: 'conversation-draft', v: 1, status: 'conflict', revision: 5 };
  };
  await f.draft.load();
  f.draft.update('我正在写的稿');
  await f.draft.flush();

  const snapshot = f.draft.snapshot();
  assert.equal(snapshot.localText, '我正在写的稿');
  assert.equal(snapshot.canonicalText, '别处更新的稿');
  assert.equal(snapshot.status, 'conflict');
  assert.deepEqual(f.calls, [['read'], ['save', 4, '我正在写的稿', scopeA], ['read']]);
});

test('scope replacement invalidates old unconfirmed intent without retrying it into the new thread', async () => {
  const oldSubmission = {
    clientMessageId: clientId, text: '只属于旧聊天', submissionRevision: 2,
    receipt: unconfirmed(),
  };
  const f = fixture([
    available({ scopeRef: scopeA, text: '只属于旧聊天', submissions: [oldSubmission] }),
    available({ scopeRef: scopeB, revision: 3, text: '新聊天草稿', submissions: [] }),
  ]);
  await f.draft.load();
  await f.draft.load();

  const snapshot = f.draft.snapshot();
  assert.equal(snapshot.scopeRef, scopeB);
  assert.equal(snapshot.localText, '只属于旧聊天');
  assert.equal(snapshot.status, 'scope_changed');
  assert.equal(f.invalidated.at(-1).clientMessageId, clientId);
  const submits = f.calls.filter(call => call[0] === 'submit');
  assert.deepEqual(submits, []);
  const retried = await f.draft.retry(oldSubmission);
  assert.equal(retried, null);
  assert.deepEqual(f.calls.filter(call => call[0] === 'submit'), []);
});

test('reservation revision conflict preserves a newer edit while retry keeps the original revision', async () => {
  const calls = [];
  let host = available({ revision: 4 });
  const client = {
    async readConversationDraft() { calls.push(['read']); return host; },
    async saveConversationDraft(expectedRevision, text, scopeRef) {
      calls.push(['save', expectedRevision, text, scopeRef]);
      if (expectedRevision !== host.revision) {
        return { kind: 'conversation-draft', v: 1, status: 'conflict', revision: host.revision };
      }
      host = { ...host, revision: host.revision + 1, text };
      return host;
    },
    async submitConversationText(text, id, submissionRevision, scopeRef) {
      calls.push(['submit', text, id, submissionRevision, scopeRef]);
      const existing = host.submissions.find(value => value.clientMessageId === id);
      if (existing) return accepted({ clientMessageId: id });
      assert.equal(submissionRevision, host.revision);
      const receipt = unconfirmed({ clientMessageId: id });
      host = { ...host, revision: host.revision + 1, submissions: [{
        clientMessageId: id, text, submissionRevision, receipt,
      }] };
      return receipt;
    },
    async readConversationDelivery(id) {
      return host.submissions.find(value => value.clientMessageId === id)?.receipt
        ?? unconfirmed({ clientMessageId: id });
    },
  };
  const draft = new HostConversationDraft({ client, uuid: () => clientId });
  await draft.load();
  draft.update('原未确认输入');
  assert.equal((await draft.submit()).delivery, 'unconfirmed');
  const original = draft.snapshot().submissions[0];
  assert.equal(original.submissionRevision, 5);
  assert.equal(host.revision, 6, 'Host reservation advances canonical revision without rewriting the intent');

  draft.update('等待期间写的新稿');
  await draft.flush();
  assert.equal(draft.snapshot().status, 'conflict');
  assert.equal(draft.snapshot().localText, '等待期间写的新稿');
  assert.equal(draft.snapshot().canonicalText, '原未确认输入');
  await draft.retry(original);

  const retries = calls.filter(call => call[0] === 'submit');
  assert.equal(retries.length, 2);
  assert.deepEqual(retries[1], retries[0],
    'retry must not replace the intent revision with the reservation revision');
});

test('a slow periodic read cannot roll back a newer successful draft save', async () => {
  let host = available({ revision: 5, text: '第五版' });
  let releaseRead;
  let delayNextRead = false;
  const client = {
    async readConversationDraft() {
      if (!delayNextRead) return host;
      const stale = host;
      return new Promise(resolve => { releaseRead = () => resolve(stale); });
    },
    async saveConversationDraft(expectedRevision, text) {
      assert.equal(expectedRevision, host.revision);
      host = { ...host, revision: host.revision + 1, text };
      return host;
    },
    async readConversationDelivery(id) { return unconfirmed({ clientMessageId: id }); },
  };
  const draft = new HostConversationDraft({ client });
  await draft.load();
  delayNextRead = true;
  const slowRead = draft.load();
  draft.update('第六版');
  await draft.flush();
  releaseRead();
  await slowRead;

  assert.equal(draft.snapshot().revision, 6);
  assert.equal(draft.snapshot().canonicalText, '第六版');
  assert.equal(draft.snapshot().localText, '第六版');
});

test('typing during an in-flight save persists the later edit after the first CAS settles', async () => {
  let host = available({ revision: 1 });
  let releaseFirstSave;
  let saveCount = 0;
  const client = {
    async readConversationDraft() { return host; },
    async saveConversationDraft(expectedRevision, text) {
      saveCount += 1;
      if (saveCount === 1) {
        return new Promise(resolve => {
          releaseFirstSave = () => {
            host = { ...host, revision: 2, text };
            resolve(host);
          };
        });
      }
      assert.equal(expectedRevision, 2);
      host = { ...host, revision: 3, text };
      return host;
    },
    async readConversationDelivery(id) { return unconfirmed({ clientMessageId: id }); },
  };
  const draft = new HostConversationDraft({ client });
  await draft.load();
  draft.update('第一笔');
  const first = draft.flush();
  draft.update('第一笔之后继续写');
  const second = draft.flush();
  releaseFirstSave();
  await Promise.all([first, second]);

  assert.equal(saveCount, 2);
  assert.equal(host.text, '第一笔之后继续写');
  assert.equal(draft.snapshot().canonicalText, '第一笔之后继续写');
  assert.equal(draft.snapshot().revision, 3);
});
