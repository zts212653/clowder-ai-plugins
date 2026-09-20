import assert from 'node:assert/strict';
import test from 'node:test';

import { assertPackedRuntimeEntrypoints } from './catalog-runtime-entrypoints.mjs';

test('accepts packed root and contribution runtime entrypoints', () => {
  assert.doesNotThrow(() => assertPackedRuntimeEntrypoints({
    runtime: { transport: 'stdio', entrypoint: 'dist/connector.js' },
    contributions: [{
      type: 'mcp',
      runtime: { transport: 'stdio', entrypoint: 'dist/mcp.js' },
    }],
  }, [
    { path: 'dist/connector.js' },
    { path: 'dist/mcp.js' },
  ]));
});

test('rejects a dangling root runtime entrypoint', () => {
  assert.throws(
    () => assertPackedRuntimeEntrypoints({
      runtime: { transport: 'stdio', entrypoint: 'dist/missing.js' },
      contributions: [],
    }, [{ path: 'dist/index.js' }]),
    /missing declared runtime entrypoint dist\/missing\.js/u,
  );
});

test('rejects a dangling contribution entrypoint even when root runtime is builtin', () => {
  assert.throws(
    () => assertPackedRuntimeEntrypoints({
      runtime: { transport: 'builtin' },
      contributions: [{
        type: 'mcp',
        runtime: { transport: 'stdio', entrypoint: 'dist/missing-mcp.js' },
      }],
    }, [{ path: 'dist/index.js' }]),
    /missing declared runtime entrypoint dist\/missing-mcp\.js/u,
  );
});
