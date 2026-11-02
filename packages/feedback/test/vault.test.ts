import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachmentVault } from '../src/attachment-vault.js';
import { attachments } from '../src/attachments.js';
import { pngFixture } from './png-fixture.js';

test('interrupted blob staging cannot occupy the hash key and concurrent retries install one complete object', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feedback-atomic-test-'));
  const image = attachments([{ mime: 'image/png', base64: pngFixture().toString('base64') }])[0]!;
  const report = { title: 'report', body: 'report', attachments: [image] };
  let interrupted = true;
  const vault = new AttachmentVault(root, async (file, bytes) => {
    if (interrupted) { interrupted = false; await writeFile(file, bytes.subarray(0, 3), { flag: 'wx' }); throw Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' }); }
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
  });
  await assert.rejects(vault.storeReport(report), /synthetic disk full/);
  await assert.rejects(access(join(root, 'feedback-attachments', image.sha256)), /ENOENT/);
  const [first, second] = await Promise.all([vault.storeReport(report), vault.storeReport(report)]);
  assert.deepEqual(first, second);
  assert.equal((await vault.readReport(first)).attachments[0]?.base64, image.base64);
});

test('an existing referenced corrupt object is refused instead of silently overwritten', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feedback-integrity-test-'));
  const image = attachments([{ mime: 'image/png', base64: pngFixture().toString('base64') }])[0]!;
  const report = { title: 'report', body: 'report', attachments: [image] }; const vault = new AttachmentVault(root);
  await vault.storeReport(report);
  const file = join(root, 'feedback-attachments', image.sha256); await writeFile(file, 'synthetic corruption');
  await assert.rejects(vault.storeReport(report), /字节已变化/);
  assert.equal(await readFile(file, 'utf8'), 'synthetic corruption');
});
