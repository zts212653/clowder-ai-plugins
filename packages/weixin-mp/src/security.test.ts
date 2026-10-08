import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { createWeixinMpHandlers, validateFilePath } from './handlers.js';
import { markdownToWxHtml } from './markdown-to-wx-html.js';
import { resolveExternalUrl, validateExternalUrl } from './safe-fetch.js';
import type { InvokeContext, InvokeHandler, InvokeResult } from './handlers.js';

const context: InvokeContext = {
  pluginConfig: { WEIXIN_MP_APP_ID: 'id', WEIXIN_MP_APP_SECRET: 'secret' },
  tokenManager: {
    getAccessToken: async () => 'test-token',
    invalidateAccessToken: async () => undefined,
    isTokenExpiredError: () => false,
  },
};

async function invoke(handler: InvokeHandler, params: Record<string, unknown>): Promise<InvokeResult> {
  try {
    return await handler(params, context);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

test('markdown conversion escapes markup, attributes, and unsafe URL schemes', () => {
  const tag = markdownToWxHtml('<script>alert(1)</script>');
  assert.doesNotMatch(tag, /<script>/);
  assert.match(tag, /&lt;script&gt;/);
  const attribute = markdownToWxHtml('![x" onerror="alert(1)](https://example.com/image.png)');
  assert.doesNotMatch(attribute, /onerror="alert/);
  assert.doesNotMatch(markdownToWxHtml('[click](javascript:alert(1))'), /javascript:/);
  assert.doesNotMatch(markdownToWxHtml('![img](\/\/evil.test/image.png)'), /src="\/\//);
  assert.match(
    markdownToWxHtml('[cdn](https://cdn.example.com/page?token=a&sig=b)'),
    /href="https:\/\/cdn\.example\.com\/page\?token=a&amp;sig=b"/,
  );
});

test('external image URLs reject local/private destinations and pin public DNS', async () => {
  assert.throws(() => validateExternalUrl('file:///etc/passwd'), /http or https/);
  assert.throws(() => validateExternalUrl('http://localhost/secret'), /blocked/);
  assert.throws(() => validateExternalUrl('http://169.254.169.254/latest/meta-data'), /private/);
  assert.throws(() => validateExternalUrl('http://[::ffff:127.0.0.1]/secret'), /private/);
  const resolved = await resolveExternalUrl(
    'https://cdn.example.test:8443/image.png?size=large',
    async () => [{ address: '93.184.216.34' }],
  );
  assert.equal(resolved.address, '93.184.216.34');
  assert.equal(resolved.hostname, 'cdn.example.test');
});

test('canonical file paths reject traversal and symlink escape', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clowder-weixin-mp-path-'));
  try {
    const resolvedRoot = await realpath(root);
    const local = join(root, 'article.md');
    await writeFile(local, '# Article');
    assert.equal(await validateFilePath(local, [resolvedRoot], 'read'), await realpath(local));
    await assert.rejects(() => validateFilePath('/etc/passwd', [resolvedRoot], 'read'), /path escapes/);
    const link = join(root, 'escape');
    await symlink('/etc', link);
    await assert.rejects(
      () => validateFilePath(join(link, 'passwd'), [resolvedRoot], 'read'),
      /path escapes/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('handlers enforce temporary-file size boundaries and controlled output paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clowder-weixin-mp-handler-'));
  try {
    const handlers = createWeixinMpHandlers({
      uploadFormData: async () => ({ errcode: 0, url: 'https://mmbiz.qpic.cn/image.png' }),
      fetchExternalUrlPinned: async () => {
        throw new Error('unexpected remote fetch');
      },
    });
    const markdown = join(root, 'article.md');
    await writeFile(markdown, '# Safe');
    const converted = await invoke(handlers['weixin-mp:convert_markdown']!, { markdownFilePath: markdown });
    assert.equal(converted.success, true);
    assert.match(String((converted as { data: { filePath: string } }).data.filePath), /wx-converted-[^/]+\/article\.html$/);

    // Each conversion lands in its own private mkdtemp directory — concurrent
    // workers/processes must never share an output file.
    const converted2 = await invoke(handlers['weixin-mp:convert_markdown']!, { markdownFilePath: markdown });
    assert.equal(converted2.success, true);
    const filePath1 = String((converted as { data: { filePath: string } }).data.filePath);
    const filePath2 = String((converted2 as { data: { filePath: string } }).data.filePath);
    assert.notEqual(filePath1, filePath2);

    const oversizedText = join(root, 'oversized.md');
    await writeFile(oversizedText, Buffer.alloc(2 * 1024 * 1024 + 1, 0x41));
    const rejectedText = await invoke(handlers['weixin-mp:convert_markdown']!, {
      markdownFilePath: oversizedText,
    });
    assert.equal(rejectedText.success, false);
    assert.match(rejectedText.error, /file too large/);

    const allowedImage = join(root, 'image.png');
    await writeFile(allowedImage, Buffer.alloc(3 * 1024 * 1024, 0x89));
    const uploaded = await invoke(handlers['weixin-mp:upload_image']!, { fileLocation: allowedImage });
    assert.deepEqual(uploaded, {
      success: true,
      data: { url: 'https://mmbiz.qpic.cn/image.png' },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
