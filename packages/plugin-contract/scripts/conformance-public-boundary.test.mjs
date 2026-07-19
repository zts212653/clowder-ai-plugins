import assert from 'node:assert/strict';
import test from 'node:test';

test('the built conformance boundary exports the stdio harness', async () => {
  const conformance = await import('@clowder-ai/plugin-contract/conformance');

  for (const exportName of [
    'HarnessChild',
    'HarnessChildExitedError',
    'HarnessTimeoutError',
    'runHarnessCase',
    'spawnHarnessChild',
    'runDualTransportOracle',
    'NdjsonFrameDecoder',
    'NdjsonFrameError',
    'encodeNdjsonFrame',
  ]) {
    assert.equal(
      typeof conformance[exportName],
      'function',
      `${exportName} must be available from the package conformance export`,
    );
  }

  assert.equal(conformance.MAX_NDJSON_FRAME_BYTES, 1_048_576);
});
