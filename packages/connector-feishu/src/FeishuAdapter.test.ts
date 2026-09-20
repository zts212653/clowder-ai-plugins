import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FeishuAdapter, inferFeishuFileType } from './FeishuAdapter.js';
import type { ConnectorLogger } from './types.js';

const noop = () => undefined;
const logger: ConnectorLogger = { info: noop, warn: noop, error: noop, debug: noop };

// H2: ogg first-page fixtures. Opus identifies with 'OpusHead' at offset 28;
// Vorbis/Speex share the OggS container and must not be declared OPUS to Feishu.
function oggPageWith(codecId: string): Buffer {
  const head = Buffer.alloc(28);
  head.write('OggS', 0, 'latin1');
  return Buffer.concat([head, Buffer.from(`${codecId}payload-payload-payload`, 'latin1')]);
}
const opusOggBytes = (): Buffer => oggPageWith('OpusHead');
const vorbisOggBytes = (): Buffer => oggPageWith('\x01vorbis\x00');

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

// F1: the production outbound path always carries `url:` (never absPath), so a
// regression here ships to users even when the absPath tests above stay green.
test('OPUS audio fetched from an external URL keeps msg_type audio', async () => {
  const subject = new FeishuAdapter('app-id', 'app-secret', logger);
  subject._injectTokenManager({
    async getTenantAccessToken() { return 'token'; },
  } as never);
  subject._injectUploadFetch(async (input, init) => {
    const target = String(input);
    if (target === 'https://cdn.example.com/media/voice.opus') {
      return new Response(opusOggBytes(), {
        status: 200,
        headers: { 'content-type': 'audio/opus; charset=binary' },
      });
    }
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

  await subject.sendMedia('chat-1', { type: 'audio', url: 'https://cdn.example.com/media/voice.opus' });

  assert.deepEqual(sent, [{ chatId: 'chat-1', msgType: 'audio' }]);
});

// G2: extensionFor resolves Content-Type first, then the URL pathname, then a
// type-based default — and never consults the prototype chain for either.
const ladderCases: Array<{
  name: string;
  contentType: string;
  url: string;
  type: 'image' | 'file' | 'audio';
  body?: Buffer;
  expectedMsgType: string;
  expectedFileName?: string;
  expectedFileType?: string;
}> = [
  {
    name: 'audio/ogg (the ogg container static servers use for OPUS) keeps opus delivery',
    contentType: 'audio/ogg',
    url: 'https://cdn.example.com/media/voice',
    type: 'audio',
    body: opusOggBytes(),
    expectedMsgType: 'audio',
    expectedFileName: 'media.opus',
    expectedFileType: 'opus',
  },
  {
    name: 'H2: a Vorbis ogg served as audio/ogg degrades to an honest file card, never declared OPUS',
    contentType: 'audio/ogg',
    url: 'https://cdn.example.com/media/music.ogg',
    type: 'audio',
    body: vorbisOggBytes(),
    expectedMsgType: 'file',
    expectedFileName: 'music.ogg',
    expectedFileType: 'stream',
  },
  {
    name: 'audio/opus keeps opus delivery',
    contentType: 'audio/opus',
    url: 'https://cdn.example.com/media/voice',
    type: 'audio',
    body: opusOggBytes(),
    expectedMsgType: 'audio',
    expectedFileName: 'media.opus',
    expectedFileType: 'opus',
  },
  {
    name: 'unknown Content-Type falls back to the URL pathname extension',
    contentType: 'application/octet-stream',
    url: 'https://cdn.example.com/media/voice.opus',
    type: 'audio',
    body: opusOggBytes(),
    expectedMsgType: 'audio',
    expectedFileName: 'voice.opus',
    expectedFileType: 'opus',
  },
  {
    name: 'unknown Content-Type without URL extension degrades to a bin file card',
    contentType: 'application/octet-stream',
    url: 'https://cdn.example.com/media/voice',
    type: 'audio',
    expectedMsgType: 'file',
    expectedFileName: 'media.bin',
    expectedFileType: 'stream',
  },
  {
    name: 'a prototype-chain Content-Type does not resolve to Object members',
    contentType: 'constructor',
    url: 'https://cdn.example.com/media/voice.opus',
    type: 'audio',
    body: opusOggBytes(),
    expectedMsgType: 'audio',
    expectedFileName: 'voice.opus',
    expectedFileType: 'opus',
  },
  {
    name: 'image without any extension hint defaults to jpg',
    contentType: 'unknown/xyz',
    url: 'https://cdn.example.com/pic',
    type: 'image',
    expectedMsgType: 'image',
  },
];

for (const ladder of ladderCases) {
  test(`extension ladder: ${ladder.name}`, async () => {
    const subject = new FeishuAdapter('app-id', 'app-secret', logger);
    subject._injectTokenManager({
      async getTenantAccessToken() { return 'token'; },
    } as never);
    subject._injectUploadFetch(async (input, init) => {
      const target = String(input);
      if (target === ladder.url) {
        return new Response(ladder.body ?? Buffer.from('bytes'), { status: 200, headers: { 'content-type': ladder.contentType } });
      }
      const form = init?.body as FormData;
      if (ladder.expectedMsgType === 'image') {
        assert.ok(form.get('image_type'), 'image upload must carry image_type');
      } else {
        assert.equal(form.get('file_name'), ladder.expectedFileName);
        assert.equal(form.get('file_type'), ladder.expectedFileType);
      }
      return new Response(JSON.stringify({ data: { file_key: 'file-key', image_key: 'image-key' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const sent: Array<{ chatId: string; msgType: string }> = [];
    subject._injectSendMessage(async ({ chatId, msgType }) => { sent.push({ chatId, msgType }); });

    await subject.sendMedia('chat-1', { type: ladder.type, url: ladder.url });

    assert.deepEqual(sent, [{ chatId: 'chat-1', msgType: ladder.expectedMsgType }]);
  });
}

// N7: type 'audio' guarantees an opus source path (deliveryTypeFor), but the
// Host display name may lack the extension; Feishu rejects a file_type /
// file_name mismatch, so the upload name must be forced to .opus.
test('audio upload forces a .opus file name when the display name lacks it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clowder-feishu-media-'));
  const filePath = join(directory, 'voice.opus');
  await writeFile(filePath, 'opus-bytes');
  try {
    const subject = new FeishuAdapter('app-id', 'app-secret', logger);
    subject._injectTokenManager({
      async getTenantAccessToken() { return 'token'; },
    } as never);
    let observed: FormData | undefined;
    subject._injectUploadFetch(async (_input, init) => {
      observed = init?.body as FormData;
      return new Response(JSON.stringify({ data: { file_key: 'file-key' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const sent: Array<{ chatId: string; msgType: string }> = [];
    subject._injectSendMessage(async ({ chatId, msgType }) => { sent.push({ chatId, msgType }); });

    await subject.sendMedia('chat-1', { type: 'audio', absPath: filePath, fileName: 'morning-voice' });

    assert.equal(observed?.get('file_name'), 'morning-voice.opus');
    assert.equal(observed?.get('file_type'), 'opus');
    assert.deepEqual(sent, [{ chatId: 'chat-1', msgType: 'audio' }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// G5: two concurrent downloads of the same URL used to share one
// tmpdir()/…-${Date.now()} path; both uploads would then carry the second
// download's bytes. Each download now gets a private mkdtemp directory.
test('concurrent sendMedia downloads of the same URL use isolated temp paths', async () => {
  const loggedPaths: string[] = [];
  const subject = new FeishuAdapter('app-id', 'app-secret', {
    info(entry: unknown) {
      const record = entry as { filePath?: string };
      if (typeof record.filePath === 'string') loggedPaths.push(record.filePath);
    },
    warn: noop, error: noop, debug: noop,
  });
  subject._injectTokenManager({
    async getTenantAccessToken() { return 'token'; },
  } as never);
  let downloadCount = 0;
  let bothDownloadsDone!: () => void;
  const gate = new Promise<void>(resolve => { bothDownloadsDone = resolve; });
  const uploads: Array<{ name: unknown; bytes: string }> = [];
  subject._injectUploadFetch(async (input, init) => {
    const target = String(input);
    if (target === 'https://cdn.example.com/media/voice.opus') {
      downloadCount += 1;
      // Valid OpusHead prefix (keeps msg_type audio under byte-sniffing) with
      // a download-unique tail so the cross-write assertion still has signal.
      const bytes = Buffer.concat([opusOggBytes(), Buffer.from(`-download-${downloadCount}`)]);
      if (downloadCount === 2) bothDownloadsDone();
      return new Response(bytes, { status: 200, headers: { 'content-type': 'audio/ogg' } });
    }
    await gate; // hold both uploads until both downloads completed
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
    subject.sendMedia('chat-1', { type: 'audio', url: 'https://cdn.example.com/media/voice.opus' }),
    subject.sendMedia('chat-1', { type: 'audio', url: 'https://cdn.example.com/media/voice.opus' }),
  ]);

  assert.equal(loggedPaths.length, 2);
  assert.notEqual(loggedPaths[0], loggedPaths[1], 'concurrent downloads must not share a temp path');
  const expectedBytes = [1, 2].map(count => Buffer.concat([opusOggBytes(), Buffer.from(`-download-${count}`)]).toString('latin1'));
  assert.deepEqual(uploads.map(entry => entry.bytes).sort(), expectedBytes.sort(),
    'each upload must carry its own download, not the clobbered last write');
  assert.deepEqual(sent, ['audio', 'audio']);
  for (const filePath of loggedPaths) {
    await assert.rejects(access(filePath), 'the temp directory must be removed after sendMedia');
  }
});
