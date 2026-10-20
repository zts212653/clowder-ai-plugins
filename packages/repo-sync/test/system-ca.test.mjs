import assert from 'node:assert/strict';
import test from 'node:test';
import { configureSystemCA } from '../src/system-ca.mjs';

test('system CA support preserves existing roots and never disables TLS verification', () => {
  let saved;
  assert.equal(
    configureSystemCA({
      getCACertificates: (kind) => (kind === 'default' ? ['EXISTING', 'EXTRA'] : ['SYSTEM', 'EXISTING']),
      setDefaultCACertificates: (values) => {
        saved = values;
      },
    }),
    true,
  );
  assert.deepEqual(saved, ['EXISTING', 'EXTRA', 'SYSTEM']);
  assert.equal(configureSystemCA({}), false);
});
