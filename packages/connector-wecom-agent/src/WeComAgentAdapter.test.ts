import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeSignature,
  decryptMessage,
  encryptMessage,
  WeComAgentAdapter,
} from './WeComAgentAdapter.js';
import type { ConnectorLogger } from './types.js';

const noop = () => undefined;
const logger: ConnectorLogger = { info: noop, warn: noop, error: noop, debug: noop };
const corpId = 'ww-test-corp';
const rawKey = Buffer.alloc(32, 7);
const encodingAesKey = rawKey.toString('base64').slice(0, 43);

function adapter() {
  return new WeComAgentAdapter(logger, {
    corpId,
    agentId: '1000002',
    agentSecret: 'agent-secret',
    token: 'callback-token',
    encodingAesKey,
  });
}

test('callback crypto authenticates signature, ciphertext, and corp identity', () => {
  const subject = adapter();
  const { aesKey, iv, token } = subject._getCryptoParams();
  const encrypted = encryptMessage('challenge', aesKey, iv, corpId);
  const signature = computeSignature(token, '1234', 'nonce', encrypted);
  assert.equal(subject.verifyCallback({
    msg_signature: signature,
    timestamp: '1234',
    nonce: 'nonce',
    echostr: encrypted,
  }), 'challenge');
  assert.equal(subject.verifyCallback({
    msg_signature: 'wrong',
    timestamp: '1234',
    nonce: 'nonce',
    echostr: encrypted,
  }), null);
  assert.deepEqual(decryptMessage(encrypted, aesKey, iv), {
    message: 'challenge',
    receivedCorpId: corpId,
  });
});

test('encrypted inbound XML validates before normalizing text and media', () => {
  const subject = adapter();
  const { aesKey, iv, token } = subject._getCryptoParams();
  const inner = '<xml><MsgType>image</MsgType><FromUserName>user-1</FromUserName><MsgId>42</MsgId><MediaId>media-1</MediaId></xml>';
  const encrypted = encryptMessage(inner, aesKey, iv, corpId);
  const signature = computeSignature(token, '1234', 'nonce', encrypted);
  const outer = `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`;
  const decrypted = subject.decryptInbound(outer, {
    msg_signature: signature,
    timestamp: '1234',
    nonce: 'nonce',
  });
  assert.equal(decrypted, inner);
  assert.deepEqual(subject.parseEvent(decrypted ?? ''), {
    chatId: 'user-1',
    text: '[图片]',
    messageId: '42',
    senderId: 'user-1',
    attachments: [{ type: 'image', mediaId: 'media-1' }],
  });
});

test('provider MsgId is stable on replay; a malformed ordinary message is rejected and warned', () => {
  const subject = adapter();
  const withId = '<xml><MsgType>text</MsgType><FromUserName>user-1</FromUserName><MsgId>42</MsgId><Content>hello</Content></xml>';
  assert.equal(subject.parseEvent(withId)?.messageId, '42');
  assert.equal(subject.parseEvent(withId)?.messageId, '42');
  const warnings: Array<{ type?: string }> = [];
  const guarded = new WeComAgentAdapter({
    ...logger,
    warn(data: unknown) { warnings.push(data as { type?: string }); },
  }, { corpId, agentId: '1000002', agentSecret: 'agent-secret', token: 'callback-token', encodingAesKey });
  const withoutId = '<xml><MsgType>text</MsgType><FromUserName>user-1</FromUserName><Content>hello</Content></xml>';
  assert.equal(guarded.parseEvent(withoutId), null);
  assert.deepEqual(warnings, [{ type: 'text' }]);
  assert.equal(guarded.parseEvent('<xml><MsgType>event</MsgType><FromUserName>user-1</FromUserName></xml>'), null);
  assert.deepEqual(warnings, [{ type: 'text' }], 'unsupported provider events must not be called malformed messages');
});

test('outbound delivery obtains a short-lived token and sends only the intended recipient body', async () => {
  const subject = adapter();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  subject._injectFetch((async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/gettoken?')) {
      return new Response(JSON.stringify({ errcode: 0, access_token: 'provider-token', expires_in: 7200 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ errcode: 0 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch);

  await subject.sendReply('user-1', 'hello');
  assert.equal(calls.length, 2);
  assert.match(calls[0]?.url ?? '', /\/gettoken\?/u);
  assert.match(calls[1]?.url ?? '', /\/message\/send\?access_token=provider-token/u);
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    touser: 'user-1',
    msgtype: 'text',
    agentid: 1000002,
    text: { content: 'hello' },
  });
});

test('byte-bounded chunking never splits a Unicode scalar or loses content', () => {
  const text = '🐱'.repeat(600);
  const chunks = adapter().chunkMessage(text, 2048);
  assert.ok(chunks.length >= 2);
  assert.equal(chunks.join(''), text);
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk, 'utf8') <= 2048);
    assert.doesNotMatch(chunk, /[\uD800-\uDFFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  }
});
