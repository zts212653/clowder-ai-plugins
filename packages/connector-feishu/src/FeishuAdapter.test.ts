import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FeishuAdapter } from './FeishuAdapter.js';
import type { ConnectorLogger } from './types.js';

const noop = () => undefined;
const logger: ConnectorLogger = { info: noop, warn: noop, error: noop, debug: noop };

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
  assert.equal(subject.verifyEventToken({ header: { token: 'wrong' } }), false);
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
  const directory = await mkdtemp(join(tmpdir(), 'clowder-feishu-media-'));
  const filePath = join(directory, 'voice.mp3');
  await writeFile(filePath, 'audio-bytes');
  try {
    const subject = new FeishuAdapter('app-id', 'app-secret', logger);
    subject._injectTokenManager({
      async getTenantAccessToken() { return 'token'; },
    } as never);
    subject._injectUploadFetch(async (_input, init) => {
      const form = init?.body as FormData;
      assert.equal(form.get('file_name'), 'voice.mp3');
      assert.equal(form.get('file_type'), 'stream');
      return new Response(JSON.stringify({ data: { file_key: 'file-key' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const sent: Array<{ chatId: string; msgType: string }> = [];
    subject._injectSendMessage(async ({ chatId, msgType }) => { sent.push({ chatId, msgType }); });

    await subject.sendMedia('chat-1', { type: 'audio', absPath: filePath, fileName: 'voice.mp3' });

    assert.deepEqual(sent, [{ chatId: 'chat-1', msgType: 'file' }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('FeishuAdapter holds no process-spawning capability', () => {
  // B8: the connector vocabulary grants no process/filesystem capability, so a
  // transcoder cannot exist. This guard fails the build if any child-process or
  // ffmpeg reference is reintroduced — the structural half of the
  // "without spawning a transcoder" property (the behavioral half is asserted
  // by the media test above).
  const source = readFileSync(new URL('./FeishuAdapter.ts', import.meta.url), 'utf8');
  assert.ok(!source.includes('child_process'), 'FeishuAdapter must not import node:child_process');
  assert.ok(!source.includes('ffmpeg'), 'FeishuAdapter must not reference ffmpeg');
  assert.ok(!source.includes('execFile'), 'FeishuAdapter must not spawn child processes');
});

test('OPUS audio keeps msg_type audio', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clowder-feishu-media-'));
  const filePath = join(directory, 'voice.opus');
  await writeFile(filePath, 'opus-bytes');
  try {
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

    await subject.sendMedia('chat-1', { type: 'audio', absPath: filePath, fileName: 'voice.opus' });

    assert.deepEqual(sent, [{ chatId: 'chat-1', msgType: 'audio' }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
