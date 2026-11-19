import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MEMORY_PROTOCOL_MAJOR,
  MEMORY_STORAGE_FORMAT,
  MEMORY_REQUIRED_OPERATIONS,
  explainDescriptor,
  isCompatibleDescriptor,
  memoryDescriptor,
  parseDispatch,
  parseKvDelete,
  parseKvGet,
  parseKvList,
  parseKvPut,
} from './index.js';

test('descriptor is business-parameter free and reports the v1 wire contract', () => {
  const descriptor = memoryDescriptor();
  assert.equal(descriptor.protocolMajor, MEMORY_PROTOCOL_MAJOR);
  assert.equal(descriptor.protocolMajor, 1);
  assert.equal(descriptor.storageFormat, MEMORY_STORAGE_FORMAT);
  assert.equal(descriptor.storageFormat, 1);
  assert.deepEqual([...descriptor.operations].sort(), [...MEMORY_REQUIRED_OPERATIONS].sort());
});

test('the v1 required operation set is exactly the first real consumers', () => {
  assert.deepEqual([...MEMORY_REQUIRED_OPERATIONS].sort(), ['kv.delete', 'kv.get', 'kv.list', 'kv.put']);
});

test('descriptor compatibility is decided by major, required operations and readable format', () => {
  assert.equal(isCompatibleDescriptor(memoryDescriptor()), true);
  assert.equal(
    isCompatibleDescriptor({ protocolMajor: 1, operations: [...MEMORY_REQUIRED_OPERATIONS], storageFormat: 1 }),
    true,
  );
  assert.equal(
    isCompatibleDescriptor({ protocolMajor: 2, operations: [...MEMORY_REQUIRED_OPERATIONS], storageFormat: 1 }),
    false,
  );
  assert.equal(
    isCompatibleDescriptor({ protocolMajor: 1, operations: ['kv.get'], storageFormat: 1 }),
    false,
  );
  assert.equal(
    isCompatibleDescriptor({ protocolMajor: 1, operations: [...MEMORY_REQUIRED_OPERATIONS], storageFormat: 2 }),
    false,
  );
  assert.equal(isCompatibleDescriptor(undefined), false);
  assert.equal(isCompatibleDescriptor({ protocolMajor: 1 }), false);
});

test('the descriptor explanation names the exact incompatibility', () => {
  assert.match(explainDescriptor({ protocolMajor: 1, operations: ['kv.get'], storageFormat: 1 }), /kv\.(put|list|delete)/);
  assert.match(explainDescriptor({ protocolMajor: 9, operations: [...MEMORY_REQUIRED_OPERATIONS], storageFormat: 1 }), /protocolMajor/);
  assert.match(explainDescriptor({ protocolMajor: 1, operations: [...MEMORY_REQUIRED_OPERATIONS], storageFormat: 7 }), /storageFormat/);
  assert.match(explainDescriptor(undefined), /descriptor/i);
});

test('kv writes carry the caller thread, key, value and author, and reject an invalid shape once', () => {
  assert.deepEqual(parseKvPut({ threadRef: 'thread-1', key: 'k', value: 'v', updatedBy: 'user' }), {
    threadRef: 'thread-1',
    key: 'k',
    value: 'v',
    updatedBy: 'user',
  });
  assert.throws(() => parseKvPut({ threadRef: '', key: 'k', value: 'v', updatedBy: 'user' }), /threadRef/);
  assert.throws(() => parseKvPut({ threadRef: 'thread-1', key: '', value: 'v', updatedBy: 'user' }), /key/);
  assert.throws(() => parseKvPut({ threadRef: 'thread-1', key: 'k', value: '', updatedBy: 'user' }), /value/);
  assert.throws(() => parseKvPut({ threadRef: 'thread-1', key: 'k', value: 'v' }), /updatedBy/);
  assert.throws(() => parseKvPut({ threadRef: 'thread-1', key: 'k', value: 'v', updatedBy: '' }), /updatedBy/);
  assert.throws(() => parseKvPut({ threadRef: 'thread-1', key: 'k', value: 'v', updatedBy: 'user', extra: 1 }), /extra/);
  assert.throws(() => parseKvPut(null), /object/);
});

test('kv writes preserve the Host length ceilings instead of inventing new ones', () => {
  const long = 'x'.repeat(101);
  const huge = 'x'.repeat(10001);
  assert.throws(() => parseKvPut({ threadRef: long, key: 'k', value: 'v', updatedBy: 'user' }), /threadRef/);
  assert.throws(() => parseKvPut({ threadRef: 'thread-1', key: long, value: 'v', updatedBy: 'user' }), /key/);
  assert.throws(() => parseKvPut({ threadRef: 'thread-1', key: 'k', value: huge, updatedBy: 'user' }), /value/);
  assert.doesNotThrow(() =>
    parseKvPut({ threadRef: 'x'.repeat(100), key: 'x'.repeat(100), value: 'x'.repeat(10000), updatedBy: 'user' }),
  );
});

test('reads, lists and deletes carry only what the operation needs', () => {
  assert.deepEqual(parseKvGet({ threadRef: 'thread-1', key: 'k' }), { threadRef: 'thread-1', key: 'k' });
  assert.deepEqual(parseKvList({ threadRef: 'thread-1' }), { threadRef: 'thread-1' });
  assert.deepEqual(parseKvDelete({ threadRef: 'thread-1', key: 'k' }), { threadRef: 'thread-1', key: 'k' });
  assert.throws(() => parseKvGet({ threadRef: 'thread-1' }), /key/);
  assert.throws(() => parseKvList({ threadRef: 'thread-1', key: 'k' }), /key/);
  assert.throws(() => parseKvDelete({ threadRef: 'thread-1' }), /key/);
});

test('dispatch parses the operation discriminator and its typed input once', () => {
  assert.deepEqual(parseDispatch({ operation: 'kv.put', input: { threadRef: 't', key: 'k', value: 'v', updatedBy: 'user' } }), {
    operation: 'kv.put',
    input: { threadRef: 't', key: 'k', value: 'v', updatedBy: 'user' },
  });
  assert.throws(() => parseDispatch({ operation: 'kv.nope', input: {} }), /operation/);
  assert.throws(() => parseDispatch({ operation: 'kv.put' }), /input/);
  assert.throws(() => parseDispatch({ input: {} }), /operation/);
  assert.throws(
    () => parseDispatch({ operation: 'kv.get', input: { threadRef: 't', key: 'k', value: 'smuggled' } }),
    /value/,
  );
});
