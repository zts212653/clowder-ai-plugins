import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { FeishuAdapter, inferFeishuFileType } from './FeishuAdapter.js';
import type { ConnectorLogger } from './types.js';

const noop = () => undefined;
const logger: ConnectorLogger = { info: noop, warn: noop, error: noop, debug: noop };

async function* mediaBytes(value: string | Buffer): AsyncGenerator<Uint8Array> {
  yield typeof value === 'string' ? Buffer.from(value) : value;
}

// H3: extension→file_type mapping must never consult the prototype chain.
test('inferFeishuFileType treats prototype-member extensions as unknown', () => {
  assert.equal(inferFeishuFileType('report.constructor'), 'stream');
  assert.equal(inferFeishuFileType('report.__proto__'), 'stream');
  assert.equal(inferFeishuFileType('notes.pdf'), 'pdf');
});

test('parses authenticated direct text without deriving Host wake authority', () => {
  const subject = new FeishuAdapter('app-id', 'app-secret', logger, { verificationToken: 'verify-me' });
  const event = {
    header: { event_type: 'im.message.receive_v1', event_id: 'evt-001', token: 'verify-me' },
    event: {
      sender: { sender_id: { open_id: 'ou_sender_123' }, sender_type: 'user' },
      message: {
        message_id: 'om_msg_456',
        chat_id: 'oc_chat_789',
        chat_type: 'p2p',
        content: JSON.stringify({ text: '@agent ordinary provider text' }),
        message_type: 'text',
      },
    },
  };
  assert.equal(subject.verifyEventToken(event), true);
  assert.deepEqual(subject.parseEvent(event), {
    chatId: 'oc_chat_789',
    text: '@agent ordinary provider text',
    messageId: 'om_msg_456',
    senderId: 'ou_sender_123',
    chatType: 'p2p',
  });
  assert.equal(subject.parseEvent({
    ...event, event: { ...event.event, message: { ...event.event.message, message_id: '' } },
  }), null, 'a malformed message cannot reach Host without a stable provider message ID');
  assert.equal(subject.verifyEventToken({ header: { token: 'wrong' } }), false);
});

test('inbound resource success and failure never print the private file key', async () => {
  const subject = new FeishuAdapter('app-id', 'app-secret', logger);
  subject._injectTokenManager({ async getTenantAccessToken() { return 'token'; } } as never);
  const privateFileKey = 'private-file-key';
  const captured: unknown[] = [];
  const methods = ['debug', 'info', 'warn', 'error'] as const;
  const original = Object.fromEntries(methods.map(method => [method, console[method]])) as Record<typeof methods[number], typeof console.log>;
  for (const method of methods) console[method] = (...args: unknown[]) => { captured.push(args); };
  try {
    subject._injectInboundFetch(async () => new Response(Buffer.from('bytes'), { status: 200 }));
    assert.deepEqual(await subject.downloadInboundMedia({
      sourceEventId: 'message-1', type: 'file', platformKey: privateFileKey,
    }), Buffer.from('bytes'));
    subject._injectInboundFetch(async () => { throw new Error('provider failed'); });
    await assert.rejects(subject.downloadInboundMedia({
      sourceEventId: 'message-1', type: 'file', platformKey: privateFileKey,
    }), /provider failed/u);
  } finally {
    for (const method of methods) console[method] = original[method];
  }
  assert.equal(JSON.stringify(captured).includes(privateFileKey), false);
});

test('inbound resource aborts the underlying header request at the adapter deadline', { timeout: 5_000 }, async () => {
  const subject = new FeishuAdapter('app-id', 'app-secret', logger);
  subject._injectTokenManager({ async getTenantAccessToken() { return 'token'; } } as never);
  subject._injectInboundMediaTimeout(5);
  let aborted = false;
  subject._injectInboundFetch((_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      aborted = true;
      reject(init.signal?.reason);
    }, { once: true });
  }));

  await assert.rejects(subject.downloadInboundMedia({
    sourceEventId: 'message-1', type: 'file', platformKey: 'file-1',
  }), /timed out/u);
  assert.equal(aborted, true);
});

test('inbound resource rejects declared oversize content and cancels its body', async () => {
  const subject = new FeishuAdapter('app-id', 'app-secret', logger);
  subject._injectTokenManager({ async getTenantAccessToken() { return 'token'; } } as never);
  let cancelled = false;
  subject._injectInboundFetch(async () => new Response(new ReadableStream<Uint8Array>({
    pull() {},
    cancel() { cancelled = true; },
  }), { status: 200, headers: { 'content-length': String(64 * 1024 * 1024 + 1) } }));

  await assert.rejects(subject.downloadInboundMedia({
    sourceEventId: 'message-1', type: 'file', platformKey: 'file-1',
  }), /safety limit/u);
  assert.equal(cancelled, true);
});

test('card action carries its provider event ID, not the card message ID', () => {
  const subject = new FeishuAdapter('app-id', 'app-secret', logger);
  const body = {
    header: { event_type: 'card.action.trigger', event_id: 'event-click-1' },
    event: {
      operator: { open_id: 'user-1' }, action: { value: { cmd: '/status' } },
      context: { open_chat_id: 'chat-1', open_chat_type: 'p2p', open_message_id: 'card-1' },
    },
  };
  assert.deepEqual(subject.parseCardAction(body), {
    eventId: 'event-click-1', chatId: 'chat-1', senderId: 'user-1',
    actionValue: { cmd: '/status' }, option: undefined, chatType: 'p2p',
  });
  assert.deepEqual(subject.parseCardAction({
    header: { event_type: 'card.action.trigger' },
    event: { ...body.event, event_id: 'event-click-2' },
  }), {
    eventId: 'event-click-2', chatId: 'chat-1', senderId: 'user-1',
    actionValue: { cmd: '/status' }, option: undefined, chatType: 'p2p',
  });
  assert.equal(subject.parseCardAction({ ...body, header: { event_type: 'card.action.trigger' } }), null);
});

test('failed and cancelled lifecycle settlements never claim the cat replied', async () => {
  const subject = new FeishuAdapter('app-id', 'app-secret', logger);
  const cards: string[] = [];
  subject._injectEditMessage(async ({ content }) => { cards.push(content); });
  await subject.finalizeStreamCard('chat-1', 'message-1', '砚砚', 'failed');
  await subject.finalizeStreamCard('chat-1', 'message-2', '砚砚', 'cancelled');
  assert.match(cards[0] ?? '', /未能完成回复/u);
  assert.match(cards[1] ?? '', /已取消回复/u);
  assert.equal(cards.some(card => card.includes('已回复')), false);
});

test('sends configured mention aliases as provider-native mentions', async () => {
  const subject = new FeishuAdapter('app-id', 'app-secret', logger, {
    groupBotMentions: { helper: { openId: 'ou_helper', displayName: 'Helper' } },
  });
  const calls: Array<{ chatId: string; content: string; msgType: string }> = [];
  subject._injectSendMessage(async params => { calls.push(params); });
  await subject.sendReply('oc_group', '@helper inspect this');
  assert.equal(calls.length, 1);
  const payload = JSON.parse(calls[0]?.content ?? '{}') as { text?: string };
  assert.equal(payload.text, '<at user_id="ou_helper">Helper</at> inspect this');
});

test('non-Opus audio is delivered as a file without spawning a transcoder', async () => {
  const subject = new FeishuAdapter('app-id', 'app-secret', logger);
  subject._injectTokenManager({ async getTenantAccessToken() { return 'token'; } } as never);
  subject._injectUploadFetch(async (_input, init) => {
    const form = init?.body as FormData;
    assert.equal(form.get('file_name'), 'voice.mp3');
    assert.equal(form.get('file_type'), 'stream');
    return new Response(JSON.stringify({ data: { file_key: 'file-key' } }), { status: 200 });
  });
  const sent: Array<{ chatId: string; msgType: string }> = [];
  subject._injectSendMessage(async ({ chatId, msgType }) => { sent.push({ chatId, msgType }); });
  await subject.sendMedia('chat-1', { type: 'audio', content: mediaBytes('audio-bytes'), fileName: 'voice.mp3' });
  assert.deepEqual(sent, [{ chatId: 'chat-1', msgType: 'file' }]);
});

// node --test runs each file in its own process against the shared system
// tmpdir, so a concurrently executing sendMedia in another test file can
// legitimately hold a clowder-feishu-outbound-* directory for the duration
// of its upload; those disappear on their own. Poll briefly: only a genuine
// leak (a directory that is never cleaned up) survives the grace window.
async function leftoverOutboundDirs(before: Set<string>): Promise<string[]> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const after = (await readdir(tmpdir())).filter(name => name.startsWith('clowder-feishu-outbound-'));
    const leftover = after.filter(name => !before.has(name));
    if (leftover.length === 0 || Date.now() >= deadline) return leftover;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test('media upload failure removes the package-owned temporary file', async () => {
  const before = new Set((await readdir(tmpdir())).filter(name => name.startsWith('clowder-feishu-outbound-')));
  const subject = new FeishuAdapter('app-id', 'app-secret', logger);
  subject._injectTokenManager({ async getTenantAccessToken() { return 'token'; } } as never);
  subject._injectUploadFetch(async () => { throw new Error('provider upload failed'); });

  await assert.rejects(
    subject.sendMedia('chat-1', { type: 'file', content: mediaBytes('bytes'), fileName: 'report.txt' }),
    /provider upload failed/,
  );
  assert.deepEqual(await leftoverOutboundDirs(before), []);
});

test('FeishuAdapter holds no process-spawning capability', () => {
  // B8: the connector vocabulary grants no process capability, so a
  // transcoder cannot exist. This single-file substring guard fails the build
  // if a child-process or ffmpeg reference is reintroduced in FeishuAdapter —
  // it is a regression pin for this file only, not proof that no other module
  // holds ambient authority (the behavioral half is asserted by the media
  // tests above; cross-module coverage lives in the Host capability gate).
  const source = readFileSync(new URL('./FeishuAdapter.ts', import.meta.url), 'utf8');
  assert.ok(!source.includes('child_process'), 'FeishuAdapter must not import node:child_process');
  assert.ok(!source.includes('ffmpeg'), 'FeishuAdapter must not reference ffmpeg');
  assert.ok(!source.includes('execFile'), 'FeishuAdapter must not spawn child processes');
  assert.match(source, /logger: NOOP_SDK_LOGGER/u, 'Feishu SDK logging must remain disabled');
});

test('OPUS audio keeps msg_type audio', async () => {
  const subject = new FeishuAdapter('app-id', 'app-secret', logger);
  subject._injectTokenManager({ async getTenantAccessToken() { return 'token'; } } as never);
  subject._injectUploadFetch(async (_input, init) => {
    const form = init?.body as FormData;
    assert.equal(form.get('file_name'), 'voice.opus');
    assert.equal(form.get('file_type'), 'opus');
    return new Response(JSON.stringify({ data: { file_key: 'file-key' } }), { status: 200 });
  });
  const sent: Array<{ chatId: string; msgType: string }> = [];
  subject._injectSendMessage(async ({ chatId, msgType }) => { sent.push({ chatId, msgType }); });
  await subject.sendMedia('chat-1', { type: 'audio', content: mediaBytes('opus-bytes'), fileName: 'voice.opus' });
  assert.deepEqual(sent, [{ chatId: 'chat-1', msgType: 'audio' }]);
});

test('OPUS audio from a Host-authorized stream keeps msg_type audio', async () => {
  const subject = new FeishuAdapter('app-id', 'app-secret', logger);
  subject._injectTokenManager({
    async getTenantAccessToken() { return 'token'; },
  } as never);
  subject._injectUploadFetch(async (_input, init) => {
    const form = init?.body as FormData;
    assert.equal(form.get('file_name'), 'voice.opus');
    assert.equal(form.get('file_type'), 'opus');
    return new Response(JSON.stringify({ data: { file_key: 'file-key' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const sent: Array<{ chatId: string; msgType: string }> = [];
  subject._injectSendMessage(async ({ chatId, msgType }) => { sent.push({ chatId, msgType }); });

  await subject.sendMedia('chat-1', {
    type: 'audio', content: mediaBytes('opus-bytes'), fileName: 'voice.opus',
  });

  assert.deepEqual(sent, [{ chatId: 'chat-1', msgType: 'audio' }]);
});

// Explicit display filenames determine Feishu's upload type. Provider URLs and
// their headers are no longer accepted as ambient media authority.
const ladderCases: Array<{
  name: string;
  type: 'image' | 'file' | 'audio';
  fileName: string;
  expectedMsgType: string;
  expectedFileType?: string;
}> = [
  {
    name: 'an .opus filename keeps audio delivery',
    type: 'audio',
    fileName: 'voice.opus',
    expectedMsgType: 'audio',
    expectedFileType: 'opus',
  },
  {
    name: 'an .ogg filename degrades to an honest file card',
    type: 'audio',
    fileName: 'music.ogg',
    expectedMsgType: 'file',
    expectedFileType: 'stream',
  },
  {
    name: 'an unknown audio filename degrades to a bin file card',
    type: 'audio',
    fileName: 'media.bin',
    expectedMsgType: 'file',
    expectedFileType: 'stream',
  },
  {
    name: 'an image filename uses the image upload route',
    type: 'image',
    fileName: 'media.jpg',
    expectedMsgType: 'image',
  },
];

for (const ladder of ladderCases) {
  test(`explicit media filename: ${ladder.name}`, async () => {
    const subject = new FeishuAdapter('app-id', 'app-secret', logger);
    subject._injectTokenManager({
      async getTenantAccessToken() { return 'token'; },
    } as never);
    subject._injectUploadFetch(async (_input, init) => {
      const form = init?.body as FormData;
      if (ladder.expectedMsgType === 'image') {
        assert.ok(form.get('image_type'), 'image upload must carry image_type');
      } else {
        assert.equal(form.get('file_name'), ladder.fileName);
        assert.equal(form.get('file_type'), ladder.expectedFileType);
      }
      return new Response(JSON.stringify({ data: { file_key: 'file-key', image_key: 'image-key' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const sent: Array<{ chatId: string; msgType: string }> = [];
    subject._injectSendMessage(async ({ chatId, msgType }) => { sent.push({ chatId, msgType }); });

    await subject.sendMedia('chat-1', {
      type: ladder.type,
      content: mediaBytes('bytes'),
      fileName: ladder.fileName,
    });

    assert.deepEqual(sent, [{ chatId: 'chat-1', msgType: ladder.expectedMsgType }]);
  });
}

test('audio upload preserves an explicit .opus display name', async () => {
  const subject = new FeishuAdapter('app-id', 'app-secret', logger);
  subject._injectTokenManager({ async getTenantAccessToken() { return 'token'; } } as never);
  let observed: FormData | undefined;
  subject._injectUploadFetch(async (_input, init) => {
    observed = init?.body as FormData;
    return new Response(JSON.stringify({ data: { file_key: 'file-key' } }), { status: 200 });
  });
  const sent: Array<{ chatId: string; msgType: string }> = [];
  subject._injectSendMessage(async ({ chatId, msgType }) => { sent.push({ chatId, msgType }); });
  await subject.sendMedia('chat-1', {
    type: 'audio', content: mediaBytes('opus-bytes'), fileName: 'morning-voice.opus',
  });
  assert.equal(observed?.get('file_name'), 'morning-voice.opus');
  assert.equal(observed?.get('file_type'), 'opus');
  assert.deepEqual(sent, [{ chatId: 'chat-1', msgType: 'audio' }]);
});

// G5: two concurrent downloads of the same URL used to share one
// tmpdir()/…-${Date.now()} path; both uploads would then carry the second
// download's bytes. Each download now gets a private mkdtemp directory.
test('concurrent Host media streams remain isolated through provider upload', async () => {
  const subject = new FeishuAdapter('app-id', 'app-secret', logger);
  subject._injectTokenManager({
    async getTenantAccessToken() { return 'token'; },
  } as never);
  const uploads: Array<{ name: unknown; bytes: string }> = [];
  subject._injectUploadFetch(async (_input, init) => {
    const form = init?.body as FormData;
    uploads.push({
      name: form.get('file_name'),
      bytes: await (form.get('file') as Blob).text(),
    });
    return new Response(JSON.stringify({ data: { file_key: `file-key-${uploads.length}` } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const sent: string[] = [];
  subject._injectSendMessage(async ({ msgType }) => { sent.push(msgType); });

  await Promise.all([
    subject.sendMedia('chat-1', { type: 'audio', content: mediaBytes('first'), fileName: 'first.opus' }),
    subject.sendMedia('chat-1', { type: 'audio', content: mediaBytes('second'), fileName: 'second.opus' }),
  ]);

  assert.deepEqual(uploads.sort((a, b) => String(a.name).localeCompare(String(b.name))), [
    { name: 'first.opus', bytes: 'first' },
    { name: 'second.opus', bytes: 'second' },
  ]);
  assert.deepEqual(sent, ['audio', 'audio']);
});
