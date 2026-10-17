import assert from 'node:assert/strict';
import test from 'node:test';

import type { ActionDef } from '../generated/contract.generated.js';
import { validateOperationRowsResult } from './operation-rows.js';

const operation = {
  actions: [
    {
      id: 'list',
      label: 'List',
      render: 'status',
      action: { method: 'list' },
    },
    {
      id: 'revoke',
      label: 'Revoke',
      render: 'row',
      action: { method: 'revoke' },
    },
  ] as readonly ActionDef[],
};

const validRows = {
  rows: [
    {
      key: 'conv-1',
      label: 'Conversation one',
      detail: 'https://chatgpt.com/c/conv-1',
      actions: [{ action: 'revoke', input: { conversationId: 'conv-1' } }],
    },
  ],
  empty: 'No conversations',
};

test('admits a structurally valid rows result referencing a declared row action', () => {
  const result = validateOperationRowsResult(operation, validRows);
  assert.equal(result.valid, true);
  if (result.valid) assert.equal(result.value, validRows);
});

test('rejects rows with duplicate keys', () => {
  const duplicate = {
    rows: [
      { key: 'same', label: 'One' },
      { key: 'same', label: 'Two' },
    ],
  };
  const result = validateOperationRowsResult(operation, duplicate);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.equal(result.errors[0].instancePath, '/rows/1/key');
    assert.equal(result.errors[0].keyword, 'uniqueKeys');
  }
});

test('rejects row actions referencing undeclared or non-row actions', () => {
  const undeclared = validateOperationRowsResult(operation, {
    rows: [{ key: 'k', label: 'L', actions: [{ action: 'missing', input: { a: 1 } }] }],
  });
  assert.equal(undeclared.valid, false);
  if (!undeclared.valid) assert.equal(undeclared.errors[0].keyword, 'rowActionReference');

  const nonRow = validateOperationRowsResult(operation, {
    rows: [{ key: 'k', label: 'L', actions: [{ action: 'list', input: { a: 1 } }] }],
  });
  assert.equal(nonRow.valid, false);
  if (!nonRow.valid) assert.equal(nonRow.errors[0].instancePath, '/rows/0/actions/0/action');
});

test('enforces the v1 bounds: rows count, key length, actions per row, input keys, value length', () => {
  assert.equal(
    validateOperationRowsResult(operation, { rows: Array.from({ length: 201 }, (_, i) => ({ key: `k${i}`, label: 'L' })) }).valid,
    false,
  );
  assert.equal(
    validateOperationRowsResult(operation, { rows: Array.from({ length: 200 }, (_, i) => ({ key: `k${i}`, label: 'L' })) }).valid,
    true,
  );

  assert.equal(
    validateOperationRowsResult(operation, { rows: [{ key: 'x'.repeat(201), label: 'L' }] }).valid,
    false,
  );
  assert.equal(
    validateOperationRowsResult(operation, { rows: [{ key: 'x'.repeat(200), label: 'L' }] }).valid,
    true,
  );

  assert.equal(
    validateOperationRowsResult(operation, {
      rows: [{
        key: 'k',
        label: 'L',
        actions: Array.from({ length: 5 }, () => ({ action: 'revoke', input: { a: 1 } })),
      }],
    }).valid,
    false,
  );
  assert.equal(
    validateOperationRowsResult(operation, {
      rows: [{
        key: 'k',
        label: 'L',
        actions: Array.from({ length: 4 }, () => ({ action: 'revoke', input: { a: 1 } })),
      }],
    }).valid,
    true,
  );

  assert.equal(
    validateOperationRowsResult(operation, {
      rows: [{ key: 'k', label: 'L', actions: [{ action: 'revoke', input: {} }] }],
    }).valid,
    false,
  );
  const sixteenKeys = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, i]));
  assert.equal(
    validateOperationRowsResult(operation, {
      rows: [{ key: 'k', label: 'L', actions: [{ action: 'revoke', input: sixteenKeys }] }],
    }).valid,
    true,
  );

  assert.equal(
    validateOperationRowsResult(operation, {
      rows: [{ key: 'k', label: 'L', actions: [{ action: 'revoke', input: { a: 'x'.repeat(1001) } }] }],
    }).valid,
    false,
  );
  assert.equal(
    validateOperationRowsResult(operation, {
      rows: [{ key: 'k', label: 'L', actions: [{ action: 'revoke', input: { a: 'x'.repeat(1000) } }] }],
    }).valid,
    true,
  );
});

test('enforces key grammar, empty text length, and row action confirm bound', () => {
  assert.equal(
    validateOperationRowsResult(operation, { rows: [{ key: 'k', label: 'L' }], empty: 'x'.repeat(201) }).valid,
    false,
  );
  assert.equal(
    validateOperationRowsResult(operation, { rows: [{ key: 'k', label: 'L' }], empty: 'x'.repeat(200) }).valid,
    true,
  );
  assert.equal(
    validateOperationRowsResult(operation, {
      rows: [{
        key: 'k',
        label: 'L',
        actions: [{ action: 'revoke', input: { a: 1 }, confirm: 'x'.repeat(201) }],
      }],
    }).valid,
    false,
  );
  assert.equal(
    validateOperationRowsResult(operation, {
      rows: [{
        key: 'k',
        label: 'L',
        actions: [{ action: 'revoke', input: { a: 1 }, confirm: 'x'.repeat(200) }],
      }],
    }).valid,
    true,
  );
});

test('fails closed for values outside the JSON domain', () => {
  for (const value of [null, [], 'rows', { rows: [{ key: 'k', label: 'L' }], extra: 1 }]) {
    assert.equal(validateOperationRowsResult(operation, value).valid, false);
  }
});
