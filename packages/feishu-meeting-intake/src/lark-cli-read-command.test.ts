import assert from 'node:assert/strict';
import test from 'node:test';

import { FeishuGatewayError } from './gateway.js';
import { parseLarkCliReadOutput } from './lark-cli-read-command.js';

test('parses one bounded JSON envelope after the package-owned installer notice', () => {
  assert.deepEqual(parseLarkCliReadOutput([
    'lark-cli v1.0.85 installed successfully',
    '{',
    '  "ok": true,',
    '  "data": {"items": []}',
    '}',
  ].join('\n')), {
    ok: true,
    data: { items: [] },
  });
});

test('rejects unknown preambles, trailing output, and incomplete JSON', () => {
  for (const output of [
    'unknown preamble\n{"ok":true}',
    '{"ok":true}\ntrailing',
    '{"ok":true',
  ]) {
    assert.throws(
      () => parseLarkCliReadOutput(output),
      error => error instanceof FeishuGatewayError && error.code === 'UNAVAILABLE',
    );
  }
});
