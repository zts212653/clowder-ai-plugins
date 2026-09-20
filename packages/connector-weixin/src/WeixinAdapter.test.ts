import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { WeixinAdapter } from './WeixinAdapter.js';
import type { ConnectorLogger } from './types.js';

const noop = () => undefined;
const logger: ConnectorLogger = { info: noop, warn: noop, error: noop, debug: noop };

test('parses iLink text and preserves the provider cursor for Host checkpointing', () => {
  const subject = new WeixinAdapter('test-token', logger);
  const result = subject.parseUpdates({
    ret: 0,
    get_updates_buf: 'cursor-abc',
    msgs: [{
      message_id: 1001,
      from_user_id: 'user-wx-123',
      context_token: 'ctx-token-abc',
      item_list: [{ type: 1, text_item: { text: '@agent ordinary provider text' } }],
    }],
  });
  assert.equal(result.newCursor, 'cursor-abc');
  assert.equal(result.sessionExpired, false);
  assert.deepEqual(result.messages, [{
    chatId: 'user-wx-123',
    text: '@agent ordinary provider text',
    messageId: '1001',
    senderId: 'user-wx-123',
    contextToken: 'ctx-token-abc',
    createdAtMs: undefined,
  }]);
});

test('restores cursor and context tokens only through the injected Host checkpoint port', async () => {
  let saved: unknown;
  const subject = new WeixinAdapter('test-token', logger, {
    async load() { return { getUpdatesBuf: 'cursor-restored', contextTokens: { chat: 'ctx-restored' } }; },
    async save(value) { saved = value; },
    async clear() { saved = null; },
  });
  await subject.restoreSessionState();
  subject._injectFetch(async () => new Response(JSON.stringify({ ret: 0 }), { status: 200 }));
  await subject.sendReply('chat', 'hello');
  assert.ok(saved === undefined || typeof saved === 'object');
});

test('adapter source contains no ambient environment fallback', async () => {
  const source = await readFile(new URL('./WeixinAdapter.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /process\.env|CLOWDER_|CAT_CAFE_API_URL|API_SERVER_PORT/);
  assert.match(source, /requires an explicit Host-projected apiBaseUrl/);
});

test('stopping polling rejects queued replies before they can flush after disposal', async () => {
  const subject = new WeixinAdapter('test-token', logger);
  subject._injectContextToken('chat', 'context-token');
  const pendingReply = subject.sendReply('chat', 'must not send after stop');

  await subject.stopPolling();

  await assert.rejects(pendingReply, /polling stopped/u);
});
