import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import test from 'node:test';

import { TelegramAdapter } from './TelegramAdapter.js';
import { formatTelegramHtml } from './telegram-html-formatter.js';
import { normalizeTelegramBotToken } from './token.js';
import type { ConnectorLogger, RichBlock } from './types.js';

function recordingLogger() {
  const entries = { info: [] as unknown[][], warn: [] as unknown[][], error: [] as unknown[][] };
  const logger: ConnectorLogger = {
    info: (...args) => entries.info.push([...args]),
    warn: (...args) => entries.warn.push([...args]),
    error: (...args) => entries.error.push([...args]),
  };
  return { entries, logger };
}

async function flushPollingLoop(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
}

test('token validation rejects malformed or blank secrets before adapter creation', () => {
  assert.equal(normalizeTelegramBotToken(' 123456:abcdefghij_ABC-123 '), '123456:abcdefghij_ABC-123');
  assert.equal(normalizeTelegramBotToken('not-a-token'), null);
  assert.equal(normalizeTelegramBotToken(''), null);
});

test('inbound parsing accepts only private human messages and preserves file identifiers', () => {
  const { logger } = recordingLogger();
  const subject = new TelegramAdapter('123456:abcdefghij_ABC-123', logger);
  const direct = subject.parseUpdate({
    message: {
      message_id: 456,
      from: { id: 789, is_bot: false },
      chat: { id: 123, type: 'private' },
      text: 'hello',
    },
  });
  assert.deepEqual(direct, { chatId: '123', text: 'hello', messageId: '456', senderId: '789' });
  const photo = subject.parseUpdate({
    message: {
      message_id: 457,
      from: { id: 789, is_bot: false },
      chat: { id: 123, type: 'private' },
      caption: 'photo',
      photo: [{ file_id: 'small' }, { file_id: 'largest' }],
    },
  });
  assert.deepEqual(photo?.attachments, [{ type: 'image', telegramFileId: 'largest' }]);
  assert.equal(subject.parseUpdate({ message: { from: { id: 1 }, chat: { id: 2, type: 'group' }, text: 'x' } }), null);
  assert.equal(subject.parseUpdate({ message: { from: { id: 1, is_bot: true }, chat: { id: 2, type: 'private' }, text: 'x' } }), null);
});

test('outbound text is split without truncation or surrogate-pair corruption', async () => {
  const { logger } = recordingLogger();
  const subject = new TelegramAdapter('123456:abcdefghij_ABC-123', logger);
  const sent: string[] = [];
  subject._injectSendMessage(async (_chatId, text) => {
    sent.push(text);
  });
  const value = `${'A'.repeat(4095)}😀tail`;
  await subject.sendReply('123', value);
  assert.ok(sent.length >= 2);
  assert.ok(sent.every(segment => segment.length <= 4096));
  assert.equal(sent.join(''), value);
  assert.ok(sent.every(segment => !segment.includes('\ufffd')));
});

test('concurrent lifecycle finals edit their exact Telegram placeholders even when they finish out of order', async () => {
  const { logger } = recordingLogger();
  const subject = new TelegramAdapter('123456:abcdefghij_ABC-123', logger);
  const edits: unknown[][] = [];
  const sends: unknown[][] = [];
  const deletes: unknown[][] = [];
  let nextMessageId = 42;
  subject._injectBotApiSendMessage(async () => ({ message_id: nextMessageId++ }));
  subject._injectSendMessage(async (...args) => { sends.push(args); });
  subject.editMessage = async (...args) => { edits.push(args); return true; };
  subject.deleteMessage = async (...args) => { deletes.push(args); };

  const firstPlaceholderId = await subject.sendPlaceholder('123', '🤔 思考中...');
  const secondPlaceholderId = await subject.sendPlaceholder('123', '🤔 思考中...');
  subject.registerInlinePlaceholder('123', firstPlaceholderId, 'life-1');
  subject.registerInlinePlaceholder('123', secondPlaceholderId, 'life-2');
  await subject.sendReply('123', '第二条最终回复', undefined, 'life-2');
  await subject.sendReply('123', '第一条最终回复', undefined, 'life-1');
  await subject.clearInlinePlaceholder('123', secondPlaceholderId, 'life-2');
  await subject.clearInlinePlaceholder('123', firstPlaceholderId, 'life-1');

  assert.deepEqual(edits, [
    ['123', '43', '第二条最终回复'],
    ['123', '42', '第一条最终回复'],
  ]);
  assert.deepEqual(sends, []);
  assert.deepEqual(deletes, []);
});

test('media upload failure removes the package-owned temporary file', async () => {
  const { logger } = recordingLogger();
  const subject = new TelegramAdapter('123456:abcdefghij_ABC-123', logger);
  let uploadPath = '';
  subject._injectSendMedia({
    sendPhoto: async () => undefined,
    sendDocument: async (_chatId, input) => {
      uploadPath = String((input as unknown as { fileData: string }).fileData);
      await access(uploadPath);
      throw new Error('provider upload failed');
    },
    sendVoice: async () => undefined,
  });
  async function* content(): AsyncGenerator<Uint8Array> { yield Buffer.from('bytes'); }

  await assert.rejects(
    subject.sendMedia('123', { type: 'file', content: content(), fileName: 'report.txt' }),
    /provider upload failed/,
  );
  assert.notEqual(uploadPath, '');
  await assert.rejects(access(uploadPath));
});

test('inbound media deadline aborts Telegram getFile instead of waiting for the SDK default', { timeout: 5_000 }, async () => {
  const { logger } = recordingLogger();
  const subject = new TelegramAdapter('123456:abcdefghij_ABC-123', logger);
  subject._injectInboundMediaTimeout(5);
  let aborted = false;
  subject._injectGetFile((_fileId, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      aborted = true;
      reject(signal.reason);
    }, { once: true });
  }));

  await assert.rejects(
    subject.downloadInboundMedia({ platformKey: 'file-1' }),
    /timed out/u,
  );
  assert.equal(aborted, true);
});

test('inbound media rejects provider-declared oversize content before buffering it', async () => {
  const { logger } = recordingLogger();
  const subject = new TelegramAdapter('123456:abcdefghij_ABC-123', logger);
  subject._injectGetFile(async () => ({ file_path: 'private/file.bin' }));
  let cancelled = false;
  subject._injectInboundFetch(async () => new Response(new ReadableStream<Uint8Array>({
    pull() {},
    cancel() { cancelled = true; },
  }), { status: 200, headers: { 'content-length': String(64 * 1024 * 1024 + 1) } }));

  await assert.rejects(
    subject.downloadInboundMedia({ platformKey: 'file-1' }),
    /safety limit/u,
  );
  assert.equal(cancelled, true);
});

test('rich formatter escapes untrusted HTML and keeps structured content', () => {
  const blocks: RichBlock[] = [{
    id: 'card-1',
    v: 1,
    kind: 'card',
    title: '<script>bad</script>',
    fields: [{ label: 'k&', value: '<v>' }],
  }];
  const html = formatTelegramHtml(blocks, 'Cat <admin>', 'hello & goodbye');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.match(html, /hello &amp; goodbye/);
  assert.match(html, /<b>k&amp;<\/b>: &lt;v&gt;/);
});

test('a 409 polling conflict closes the old provider session before bounded retry', async () => {
  const { entries, logger } = recordingLogger();
  const subject = new TelegramAdapter('123456:abcdefghij_ABC-123', logger);
  let starts = 0;
  let closes = 0;
  const sleeps: number[] = [];
  subject._injectPollingControls({
    start: async options => {
      starts += 1;
      if (starts === 1) throw { error_code: 409, description: 'Conflict' };
      options?.onStart?.({} as never);
    },
    close: async () => {
      closes += 1;
    },
    sleep: async ms => {
      sleeps.push(ms);
    },
    backoffMs: [5],
    maxConflictRetries: 2,
  });
  subject.startPolling(async () => undefined);
  await flushPollingLoop();
  assert.equal(starts, 2);
  assert.equal(closes, 1);
  assert.deepEqual(sleeps, [5]);
  assert.equal(entries.error.length, 0);
  assert.ok(entries.warn.some(entry => String(entry.at(-1)).includes('409 conflict')));
  await subject.stopPolling();
});

test('editMessage swallows only the not-modified 400; any other 400 propagates to the caller fallback', async () => {
  const { logger } = recordingLogger();
  const subject = new TelegramAdapter('123456:abcdefghij_ABC-123', logger);
  const notModified = Object.assign(new Error('message is not modified'), { error_code: 400, description: 'Bad Request: message is not modified' });
  const notFound = Object.assign(new Error('message to edit not found'), { error_code: 400, description: 'Bad Request: message to edit not found' });
  let next: Error = notModified;
  subject._injectBotApiEditMessage(async () => { throw next; });

  assert.equal(await subject.editMessage('123', '456', 'same text'), true, 'not-modified means the edit already applied');
  next = notFound;
  await assert.rejects(subject.editMessage('123', '456', 'new text'), (error: unknown) => (
    (error as Error).message.includes('message to edit not found')
  ));
});
