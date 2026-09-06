import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  DOCX_MATERIALIZATION_MAX_BYTES, validateDocxMaterializationRequest as request,
  validateDocxMaterializationResponse as response,
} from '../validation/docx-materialization.js';

const base = {
  protocolVersion: '1.0.0', requestId: 'request-1',
  mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  bytesBase64: Buffer.from('PK fixture bytes').toString('base64'),
  operation: { kind: 'inspect', cursor: 0, limit: 32 },
};
const target = { paragraphId: `p:0:${'a'.repeat(64)}`, textQuote: 'Original text' };
const attribution = { author: 'codex-astra', operationId: 'operation-1', timestamp: '2026-09-06T00:00:00.000Z' };

test('OOXML-bound text rejects illegal XML scalars and malformed UTF-16 instead of colliding after sanitization', () => {
  const bad = ['\u0000', '\u0008', '\u000b', '\u001f', '\ud800', '\udfff', '\ud800x\udc00', '\ufffe', '\uffff'];
  for (const text of bad) {
    assert.equal(request({ ...base, operation: { kind: 'tracked-change', target, replacement: `bad${text}text`, attribution } }), false, `replacement ${JSON.stringify(text)}`);
    assert.equal(request({ ...base, operation: { kind: 'comment', target, body: `bad${text}comment`, attribution } }), false);
    assert.equal(request({ ...base, operation: { kind: 'comment', target, body: 'Comment', attribution: { ...attribution, author: `named${text}-cat` } } }), false);
  }
  assert.ok(request({ ...base, operation: { kind: 'comment', target, body: 'Valid 中文 🐾 \t\n', attribution: { ...attribution, author: 'named-cat' } } }));
  for (const author of ['named\t-cat', 'named\n-cat', 'named\r-cat', 'named-cat\n', 'named-cat\r\n']) {
    assert.equal(request({ ...base, operation: { kind: 'comment', target, body: 'Comment', attribution: { ...attribution, author } } }), false, 'XML attribute normalization must not change attribution');
  }
  assert.equal(request({ ...base, operation: { kind: 'tracked-change', target, replacement: 'a\rb', attribution } }), false, 'upstream emits literal CR, which XML normalizes');
});

test('public protocol closes inspection, tracked-edit and comment input shapes', () => {
  assert.ok(request(base));
  assert.ok(request({ ...base, operation: { kind: 'tracked-change', target, replacement: 'New text', attribution } }));
  assert.ok(request({ ...base, operation: { kind: 'comment', target, body: 'Please check', attribution } }));
  for (const extra of [{ executionLease: 'secret' }, { path: '/tmp/docx' }, { actorId: 'forged' }, { config: {} }]) {
    assert.equal(request({ ...base, ...extra }), false);
  }
  assert.equal(request({ ...base, operation: { kind: 'eval', code: 'fetch(url)' } }), false);
  assert.equal(request({ ...base, operation: { kind: 'inspect', cursor: -1, limit: 100 } }), false);
  assert.equal(request({ ...base, operation: { kind: 'comment', target, body: '', attribution } }), false);
});

test('canonical base64 and decoded size are enforced in both directions', async () => {
  const schema = JSON.parse(await readFile(new URL('../schemas/docx-materialization.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.$defs.DocxMaterializationBytes.maxLength, Math.ceil(DOCX_MATERIALIZATION_MAX_BYTES / 3) * 4);
  for (const bytesBase64 of ['AA', 'AB==', '', Buffer.alloc(DOCX_MATERIALIZATION_MAX_BYTES + 1).toString('base64')]) {
    assert.equal(request({ ...base, bytesBase64 }), false);
    assert.equal(response({ protocolVersion: '1.0.0', requestId: 'request-1', result: { kind: 'document', bytesBase64 } }), false);
  }
});

test('worker responses cannot claim owner receipts, unbounded projections or unknown outcomes', () => {
  const envelope = { protocolVersion: '1.0.0', requestId: 'request-1' };
  assert.ok(response({ ...envelope, result: { kind: 'inspection', paragraphs: [{ target, editable: true }], nextCursor: null } }));
  assert.ok(response({ ...envelope, result: { kind: 'document', bytesBase64: base.bytesBase64 } }));
  assert.equal(response({ ...envelope, result: { kind: 'document', bytesBase64: base.bytesBase64, receiptId: 'fake' } }), false);
  assert.equal(response({ ...envelope, result: { kind: 'inspection', paragraphs: Array(33).fill({ target, editable: true }), nextCursor: null } }), false);
  assert.equal(response({ ...envelope, result: { kind: 'applied', ownerRevision: 4 } }), false);
  assert.equal(request({ ...base, operation: { kind: 'inspect', cursor: Number.NaN, limit: 1 } }), false);
  const cyclic: Record<string, unknown> = {}; cyclic.value = cyclic;
  assert.equal(response(cyclic), false);
});
