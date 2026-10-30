import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachments } from '../src/attachments.js';
import { defaultProfiles } from '../src/config.js';
import { provider } from '../src/providers.js';
import type { Host } from '../src/types.js';
import { pngFixture } from './png-fixture.js';

test('attachment CLI receives send bytes only, never the original metadata sidecar', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feedback-cli-test-'));
  const script = join(root, 'adapter.mjs'); const captured = join(root, 'request.json');
  await writeFile(script, `import fs from 'node:fs';let raw='';for await(const chunk of process.stdin)raw+=chunk;const request=JSON.parse(raw);fs.writeFileSync(process.argv[2],raw);process.stdout.write(JSON.stringify({url:'https://assets.example.test/image.png',sha256:request.payload.attachment.sha256,visibility:'public'}));`);
  const original = pngFixture(16, 'private-metadata-canary');
  const image = attachments([{ mime: 'image/png', base64: original.toString('base64'), original: { mime: 'image/png', base64: original.toString('base64') } }])[0]!;
  const adapter = provider({ secrets: { get: async () => undefined } } as Host, { ...defaultProfiles[0]!, attachmentOrigins: ['https://assets.example.test'], attachmentCommand: { executable: process.execPath, args: [script, captured] } }, async () => new Response(Buffer.from(image.base64, 'base64')));
  await adapter.upload(image, 'fixture', new AbortController().signal);
  const request = JSON.parse(await readFile(captured, 'utf8'));
  assert.equal(request.payload.attachment.original, undefined);
  assert.ok(!Buffer.from(request.payload.attachment.base64, 'base64').includes(Buffer.from('private-metadata-canary')));
  assert.ok(Buffer.from(image.original!.base64, 'base64').includes(Buffer.from('private-metadata-canary')), 'local download still retains original');
});
