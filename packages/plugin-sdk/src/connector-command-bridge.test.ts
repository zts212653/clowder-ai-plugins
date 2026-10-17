import assert from 'node:assert/strict';
import test from 'node:test';
import type { FeatureContext } from './feature-context.js';
import { createConnectorCommandBridge } from './connector-command-bridge.js';

// Substitute Host ports only. Its send ledger is scoped to plugin instance +
// idempotencyKey (not target thread or external chat).
function fixture() {
  const sent: { threadId: string; key: string }[] = [];
  const receipts = new Map<string, { messageId: string; threadId: string }>();
  const replies: string[] = [];
  const responses: string[] = [];
  const deepLinkUrl = 'https://owner.example:8443/thread/Host%2F%E7%BA%BF%3F%23%25';
  const summary = { id: 'target', deepLinkUrl, title: 'Target', createdAt: 1, lastActiveAt: 1, preferredCats: [], featureRefs: [] };
  const context = {
    storage: { async get() { return { revision: 1, value: { v: 1, whitelistEnabled: false,
      commandAdminOnly: false, adminConfigured: true, adminOpenIds: [], allowedGroups: [] } }; } },
    threads: { async get(id: string) { return id === summary.id ? summary : null; }, async findByKey() { return summary; }, async list() { return [summary]; },
      async create() { return summary; }, async readMessages() { return [
        { id: 'owner', timestamp: 1, sender: { kind: 'owner' }, content: 'question' },
        { id: 'cat', timestamp: 2, sender: { kind: 'cat', catId: 'sol' }, content: 'answer'.repeat(6000) },
      ]; }, async getCats() { return { participants: [], routableNow: [], routableNotJoined: [], notRoutable: [] }; },
      async bind() {}, async ensureSystemThread() { return { ...summary, id: 'system' }; } },
    messaging: { async send(threadId: string, draft: { idempotencyKey: string }) {
      const previous = receipts.get(draft.idempotencyKey);
      if (previous !== undefined) return previous;
      const receipt = { messageId: `m-${sent.length + 1}`, threadId };
      receipts.set(draft.idempotencyKey, receipt); sent.push({ threadId, key: draft.idempotencyKey }); return receipt;
    } },
  } as unknown as FeatureContext;
  const bridge = () => createConnectorCommandBridge(context, { connectorId: 'fixture', identityId: 'fixture',
    async bindingChanged() {}, async reply(input, result) { replies.push(input.chatId); responses.push(result.response); }, async settle() {} });
  return { sent, replies, responses, deepLinkUrl, bridge };
}

for (const text of ['/where', '/new Owner title', '/use target', '/history 1', '/status']) {
  test(`actual bridge consumes Host-authored summary navigation for ${text}`, async () => {
    const f = fixture();
    await f.bridge()({ chatId: 'chat', providerMessageId: 'navigation', group: false, text });
    assert.ok(f.responses[0]?.includes(f.deepLinkUrl), 'use the projected URL verbatim, not a guessed origin or id lookup');
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0]?.threadId, 'system');
  });
}

for (const text of ['/where', '/thread target body']) {
  test(`chat-scoped provider events retain independent audit/body sends for ${text}`, async () => {
    const { sent, replies, bridge } = fixture(); const route = bridge();
    for (const chatId of ['chat-A', 'chat-B']) await route({ chatId, providerMessageId: 'local-1', group: false, text });
    assert.deepEqual(replies, ['chat-A', 'chat-B']);
    assert.equal(sent.filter(send => send.threadId === 'system').length, 2);
    if (text.startsWith('/thread')) assert.equal(sent.filter(send => send.threadId === 'target').length, 2);
    // A fresh runtime may replay provider acknowledgement; Host sends retain
    // the same canonical keys and do not repeat the audit or explicit body.
    const count = sent.length; const restarted = bridge();
    await restarted({ chatId: 'chat-A', providerMessageId: 'local-1', group: false, text });
    assert.equal(sent.length, count);
  });
}
test('source tuple encoding is unambiguous and keys stay bounded for maximum-sized identities', async () => {
  const { sent, bridge } = fixture(); const route = bridge();
  for (const [chatId, providerMessageId] of [['a:b', 'c'], ['a', 'b:c'], ['x'.repeat(500), 'y'.repeat(500)]]) {
    await route({ chatId: chatId!, providerMessageId: providerMessageId!, group: false, text: '/where' });
  }
  assert.equal(sent.length, 3);
  assert.equal(new Set(sent.map(send => send.key)).size, 3);
  assert.ok(sent.every(send => send.key.length < 200));
});
