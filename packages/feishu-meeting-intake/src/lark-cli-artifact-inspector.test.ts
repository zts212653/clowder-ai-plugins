import assert from 'node:assert/strict';
import test from 'node:test';

import { FeishuGatewayError } from './gateway.js';
import {
  createLarkCliFeishuArtifactInspector,
  parseFeishuMinutesReference,
} from './lark-cli-artifact-inspector.js';

const SIGNAL = new AbortController().signal;
const TOKEN = 'obcne9c5d9z4l3o3nk9mg777';

test('parses a raw Minute token and tenant-scoped Feishu/Lark Minutes URLs', () => {
  assert.deepEqual(parseFeishuMinutesReference(TOKEN), {
    artifactId: TOKEN,
    kind: 'minute',
  });
  assert.deepEqual(
    parseFeishuMinutesReference(`https://example.feishu.cn/minutes/${TOKEN}?from=copy`),
    { artifactId: TOKEN, kind: 'minute' },
  );
  assert.deepEqual(
    parseFeishuMinutesReference(`https://example.larksuite.com/minutes/${TOKEN}`),
    { artifactId: TOKEN, kind: 'minute' },
  );
});

test('rejects local paths, insecure URLs, userinfo, lookalike domains, and unrelated paths', () => {
  for (const value of [
    '/tmp/transcript.txt',
    `http://example.feishu.cn/minutes/${TOKEN}`,
    `https://user@example.feishu.cn/minutes/${TOKEN}`,
    `https://example.feishu.cn.evil.test/minutes/${TOKEN}`,
    `https://example.feishu.cn/docs/${TOKEN}`,
  ]) {
    assert.throws(() => parseFeishuMinutesReference(value), TypeError);
  }
});

test('inspects a historical Minute through the existing user-authorized lark-cli read command', async () => {
  const calls: string[][] = [];
  const inspect = createLarkCliFeishuArtifactInspector({
    homeDirectory: '/Users/example',
    runCommand: async (args) => {
      calls.push([...args]);
      return {
        ok: true,
        data: {
          minute: {
            token: TOKEN,
            create_time: '1786665850000',
            title: 'Historical meeting',
            note_id: '7674075151507852250',
          },
        },
      };
    },
  });

  const artifact = await inspect({ artifactId: TOKEN, kind: 'minute' }, SIGNAL);

  assert.deepEqual(calls, [[
    'minutes', 'minutes', 'get', '--minute-token', TOKEN,
    '--as', 'user', '--format', 'json',
  ]]);
  assert.deepEqual(artifact, {
    artifactId: TOKEN,
    kind: 'minute',
    revision: '1786665850000',
    generatedAt: '2026-08-14T00:04:10.000Z',
    title: 'Historical meeting',
  });
});

test('fails closed when a requested immutable revision no longer matches Feishu truth', async () => {
  const inspect = createLarkCliFeishuArtifactInspector({
    homeDirectory: '/Users/example',
    runCommand: async () => ({
      ok: true,
      data: {
        minute: {
          token: TOKEN,
          create_time: '1786665850000',
          title: 'Historical meeting',
        },
      },
    }),
  });

  await assert.rejects(
    inspect({ artifactId: TOKEN, kind: 'minute', revision: 'different' }, SIGNAL),
    error => error instanceof FeishuGatewayError && error.code === 'NOT_FOUND',
  );
});
