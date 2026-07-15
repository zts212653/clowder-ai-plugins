import assert from 'node:assert/strict';
import test from 'node:test';

import { isValidDataClassStrategy } from './data-class.js';

test('data-class validation preserves the schema-owned strategy matrix', () => {
  assert.equal(isValidDataClassStrategy('cache', 'lifecycle'), true);
  assert.equal(isValidDataClassStrategy('user-authored', 'retained'), true);
  assert.equal(isValidDataClassStrategy('user-authored', 'lifecycle'), false);
});

test('data-class validation returns false for unknown external inputs', () => {
  assert.equal(isValidDataClassStrategy('unknown-class', 'retained'), false);
  assert.equal(isValidDataClassStrategy('cache', 'unknown-strategy'), false);
  assert.equal(isValidDataClassStrategy(null, 'retained'), false);
  assert.equal(isValidDataClassStrategy('cache', 42), false);
});
