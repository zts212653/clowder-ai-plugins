import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MEMORY_REQUIRED_OPERATIONS,
  MEMORY_SEARCH_OPERATIONS,
  explainDescriptor,
  isCompatibleDescriptor,
  memoryDescriptor,
  parseDispatch,
  parseKvPut,
  parseSearchInput,
} from './index.js';

test('search is the second operation family a compatible v1 plugin must serve', () => {
  assert.deepEqual([...MEMORY_SEARCH_OPERATIONS].sort(), ['search.query']);
  // Admission still requires only the kv family: a Host that does not use
  // retrieval must not fail because the plugin also offers it.
  assert.deepEqual([...MEMORY_REQUIRED_OPERATIONS].sort(), ['kv.delete', 'kv.get', 'kv.list', 'kv.put']);
  const descriptor = memoryDescriptor();
  for (const operation of [...MEMORY_REQUIRED_OPERATIONS, ...MEMORY_SEARCH_OPERATIONS])
    assert.ok((descriptor.operations as readonly string[]).includes(operation), operation);
});

test('a plugin that drops search is still compatible, because kv is the admission floor', () => {
  assert.equal(isCompatibleDescriptor({ protocolMajor: 1, operations: [...MEMORY_REQUIRED_OPERATIONS], storageFormat: 1 }), true);
  assert.equal(
    isCompatibleDescriptor({
      protocolMajor: 1,
      operations: [...MEMORY_REQUIRED_OPERATIONS, ...MEMORY_SEARCH_OPERATIONS],
      storageFormat: 1,
    }),
    true,
  );
  assert.match(explainDescriptor({ protocolMajor: 1, operations: ['kv.put'], storageFormat: 1 }), /kv\./);
});

test('a search query carries the caller text and only the options the Host actually passes', () => {
  assert.deepEqual(parseSearchInput({ query: 'migration witness' }), {
    query: 'migration witness',
    options: {},
  });
  assert.deepEqual(
    parseSearchInput({
      query: 'migration',
      options: { limit: 5, scope: 'memory', mode: 'hybrid', depth: 'raw', threadId: 'thread-1', explain: true },
    }),
    {
      query: 'migration',
      options: { limit: 5, scope: 'memory', mode: 'hybrid', depth: 'raw', threadId: 'thread-1', explain: true },
    },
  );
});

test('a search query is rejected at the boundary, once, on the shape that would corrupt a read', () => {
  assert.throws(() => parseSearchInput({ query: '' }), /query/);
  assert.throws(() => parseSearchInput({ query: 'x'.repeat(2001) }), /query/);
  assert.throws(() => parseSearchInput({}), /query/);
  assert.throws(() => parseSearchInput(null), /object/);
  assert.throws(() => parseSearchInput({ query: 'q', options: { mode: 'fuzzy' } }), /mode/);
  assert.throws(() => parseSearchInput({ query: 'q', options: { scope: 'everything' } }), /scope/);
  assert.throws(() => parseSearchInput({ query: 'q', options: { depth: 'full' } }), /depth/);
  assert.throws(() => parseSearchInput({ query: 'q', options: { limit: 0 } }), /limit/);
  assert.throws(() => parseSearchInput({ query: 'q', options: { limit: 21 } }), /limit/);
  assert.throws(() => parseSearchInput({ query: 'q', options: { prefix: 'x' } }), /prefix/);
  // The caller cannot widen its own authorization: grants come from the Host.
  assert.throws(() => parseSearchInput({ query: 'q', options: { authorizedCollections: ['x'] } }), /authorizedCollections/);
});

test('search dispatch keeps the same single-discriminator envelope as kv', () => {
  assert.deepEqual(parseDispatch({ operation: 'search.query', input: { query: 'witness' } }), {
    operation: 'search.query',
    input: { query: 'witness', options: {} },
  });
  assert.throws(() => parseDispatch({ operation: 'search.query', input: {} }), /query/);
  assert.throws(() => parseDispatch({ operation: 'kv.put', input: { threadRef: 't' } }), /key/);
  assert.doesNotThrow(() => parseKvPut({ threadRef: 't', key: 'k', value: 'v', updatedBy: 'user' }));
});
