import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitize } from '../src/sanitize.js';

test('removes secrets, identity, URL credentials, local roots and private hosts before model input', () => {
  const raw = 'Authorization: Bearer abcdefghijklmnop\napi_key="sk-secret-123456789"\n' +
    'C:\\Users\\Alice\\work\\foo.ts /home/bob/project/a.ts\n' +
    'https://alice:password@internal.corp/path?token=abcd&ok=1\n' +
    'alice@example.com 192.168.1.8 cat_session=uuid-secret';
  const output = sanitize(raw, ['C:\\Users\\Alice\\work']);
  for (const secret of ['abcdefghijklmnop', 'sk-secret', 'Alice', 'bob', 'password', 'internal.corp', 'abcd', 'alice@example.com', '192.168.1.8', 'uuid-secret']) {
    assert.ok(!output.includes(secret), `leaked ${secret}: ${output}`);
  }
  assert.ok(output.includes('foo.ts'));
  assert.equal(sanitize(output), output, 'sanitization must be idempotent');
});

test('retains useful evidence and scrubs structured credential blocks', () => {
  const output = sanitize('request timeout E_CONNRESET\n-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n"accessToken": "sensitive"');
  assert.ok(output.includes('E_CONNRESET'));
  assert.ok(!output.includes('secret'));
  assert.ok(!output.includes('sensitive'));
});
