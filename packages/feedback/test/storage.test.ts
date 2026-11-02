import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachments } from '../src/attachments.js';
import { fixture } from './service-fixture.js';
import { pngFixture } from './png-fixture.js';

test('large valid PNG persists outside 1 MiB Host CAS values and hydrates across bootstrap', async () => {
  const f = fixture(); const writes: unknown[] = [];
  f.host.dataPath = await mkdtemp(join(tmpdir(), 'feedback-vault-test-'));
  const original = f.host.storage.compareAndSet;
  f.host.storage.compareAndSet = async (key, revision, value) => {
    assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 1_048_576, 'real Host single-value budget');
    writes.push(value); return original(key, revision, value);
  };
  const png = pngFixture(512); assert.ok(png.length > 1_000_000);
  const saved = await f.call({ op: 'save', targetId: 'clowder', report: { title: 'large screenshot', body: 'visible pixels', attachments: [{ mime: 'image/png', base64: png.toString('base64') }] } });
  assert.ok(!JSON.stringify(writes).includes('base64'));
  const loaded = await f.service.dispatch({ op: 'bootstrap',feedbackId:f.feedbackId() }, f.ctx) as { journal: { report: { attachments: { base64: string }[] } } };
  assert.equal(loaded.journal.report.attachments[0]?.base64, saved.journal.report.attachments[0]?.base64);
});

test('automatic PNG bytes exclude hidden metadata while keeping actual image chunks', () => {
  const png = pngFixture(16, 'private-metadata-canary');
  const image = attachments([{ mime: 'image/png', base64: png.toString('base64') }])[0]!;
  const actual = Buffer.from(image.base64, 'base64');
  assert.ok(!actual.includes(Buffer.from('private-metadata-canary')));
  assert.ok(actual.includes(Buffer.from('IDAT')));
});

test('partial uploads retain each receipt and allow explicit edit recovery without creating an Issue', async () => {
  const f = fixture(); f.host.dataPath = await mkdtemp(join(tmpdir(), 'feedback-upload-test-'));
  const writes: unknown[] = []; const original = f.host.storage.compareAndSet;
  f.host.storage.compareAndSet = async (key, revision, value) => { writes.push(structuredClone(value)); return original(key, revision, value); };
  let uploads = 0;
  f.adapter.upload = async () => { uploads++; if (uploads === 2) throw new Error('synthetic second upload failure'); return '![first](https://images.example.test/first.png)'; };
  const saved = await f.call({ op: 'save', targetId: 'clowder', report: { title: 'partial', body: 'report', attachments: [16, 17].map(size => ({ mime: 'image/png', base64: pngFixture(size).toString('base64') })) } });
  await f.call({ op: 'approve', digest: saved.journal.digest, confirmed: true });
  const failed = await f.call({ op: 'submit', digest: saved.journal.digest });
  assert.equal(failed.journal.state, 'upload_failed'); assert.equal(f.creates(), 0);
  assert.equal(failed.journal.uploads?.length, 1); assert.match(JSON.stringify(writes), /first\.png/);
  const reset = await f.call({ op: 'reset-upload', digest: failed.journal.digest, confirmed: true });
  assert.equal(reset.journal.state, 'draft'); assert.notEqual(reset.journal.id, failed.journal.id);
  await assert.rejects(f.call({ op: 'approve', digest: failed.journal.digest, confirmed: true }), /版本已变化/);
  assert.equal(uploads, 2, 'reset never uploads');
});

test('known Issue survives readback failure without another create', async () => {
  const f = fixture(); const read = f.adapter.read; f.adapter.read = async () => { throw new Error('synthetic read outage'); };
  const saved = await f.call({ op: 'save', targetId: 'clowder', report: { title: 'known issue', body: 'report', attachments: [] } });
  await f.call({ op: 'approve', digest: saved.journal.digest, confirmed: true });
  const pending = await f.call({ op: 'submit', digest: saved.journal.digest });
  assert.equal(pending.journal.state, 'unknown'); assert.match(pending.journal.issue?.url ?? '', /\/issues\/12$/);
  f.adapter.read = read;
  const verified = await f.call({ op: 'reconcile', digest: pending.journal.digest });
  assert.equal(verified.journal.state, 'published'); assert.equal(f.creates(), 1);
});
