import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { collectiveMessageAttachmentSchema } from '../src/business/contracts/types/collective-message-content.js';
import { isCollectiveAttachmentUrl } from '../src/business/contracts/types/collective-message-rich.js';
import { createCollectiveMcpServer } from '../src/mcp-server.js';
import { createCollectiveOwnerMcpServer } from '../src/owner-mcp-server.js';
import { createCollectiveWorkMcpServer } from '../src/work-mcp-server.js';

function checkPatterns(value: unknown, path: string): void {
  if (!value || typeof value !== 'object') return;
  Object.entries(value).forEach(([key, child]) => {
    if (key === 'pattern') {
      assert.equal(typeof child, 'string', path);
      assert.doesNotThrow(() => new RegExp(child as string, 'u'), `${path}: ${child}`);
    } else checkPatterns(child, `${path}/${key}`);
  });
}

([
  ['public', createCollectiveMcpServer],
  ['owner', createCollectiveOwnerMcpServer],
  ['work', createCollectiveWorkMcpServer],
] as const).forEach(([name, createServer]) => {
  test(`${name} tools/list exports portable regex patterns without dropping its schema dialect`, async () => {
    const server = createServer({ async invoke() { throw Error('No action expected during tools/list'); } });
    const client = new Client({ name: 'schema-portability', version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(st), client.connect(ct)]);
      const { tools } = await client.listTools();
      assert.ok(tools.length > 0);
      tools.forEach(tool => {
        assert.equal(tool.inputSchema.$schema, 'http://json-schema.org/draft-07/schema#', tool.name);
        checkPatterns(tool.inputSchema, tool.name);
      });
    } finally { await client.close(); await server.close(); }
  });
});

test('portable attachment prefixes retain the original input and numeric bounds', () => {
  const attachment = {
    v: 1, attachmentId: 'att_12345678', contentRef: 'collective-attachment:abc', ownerRevision: 1,
    ownerReceiptRef: 'receipt', blobDigest: `sha256:${'a'.repeat(64)}`, byteLength: 1,
    mediaType: 'image/png', fileName: 'example.png',
  };
  assert.equal(collectiveMessageAttachmentSchema.safeParse(attachment).success, true);
  assert.equal(isCollectiveAttachmentUrl(attachment.contentRef), true);
  ['https://example.com/file', 'other-attachment:abc', `collective-attachment:${'x'.repeat(240)}`].forEach(contentRef => {
    assert.equal(collectiveMessageAttachmentSchema.safeParse({ ...attachment, contentRef }).success, false);
    assert.equal(isCollectiveAttachmentUrl(contentRef), false);
  });
  [0, -1, 1.5, 50 * 1024 * 1024 + 1].forEach(byteLength => {
    assert.equal(collectiveMessageAttachmentSchema.safeParse({ ...attachment, byteLength }).success, false);
  });
});
