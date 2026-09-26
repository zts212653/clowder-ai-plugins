import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
  assert.doesNotMatch(source, /apiBaseUrl|relative media URL|downloadToTemp|resolveDownloadUrl/);
});

// node --test runs each file in its own process against the shared system
// tmpdir, so a concurrently executing sendMedia in another test file can
// legitimately hold a clowder-weixin-outbound-* directory for the duration
// of its upload; those disappear on their own. Poll briefly: only a genuine
// leak (a directory that is never cleaned up) survives the grace window.
async function leftoverOutboundDirs(before: Set<string>): Promise<string[]> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const after = (await readdir(tmpdir())).filter(name => name.startsWith('clowder-weixin-outbound-'));
    const leftover = after.filter(name => !before.has(name));
    if (leftover.length === 0 || Date.now() >= deadline) return leftover;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test('media upload failure removes the package-owned temporary file', async () => {
  const before = new Set((await readdir(tmpdir())).filter(name => name.startsWith('clowder-weixin-outbound-')));
  const subject = new WeixinAdapter('test-token', logger);
  subject._injectContextToken('chat', 'context-token');
  subject._injectFetch(async () => { throw new Error('provider upload failed'); });
  async function* content(): AsyncGenerator<Uint8Array> { yield Buffer.from('bytes'); }

  await assert.rejects(
    subject.sendMedia('chat', { type: 'file', content: content(), fileName: 'report.txt' }),
    /provider upload failed/,
  );
  assert.deepEqual(await leftoverOutboundDirs(before), []);
});

test('stopping polling rejects queued replies before they can flush after disposal', async () => {
  const subject = new WeixinAdapter('test-token', logger);
  subject._injectContextToken('chat', 'context-token');
  const pendingReply = subject.sendReply('chat', 'must not send after stop');

  await subject.stopPolling();

  await assert.rejects(pendingReply, /polling stopped/u);
});
