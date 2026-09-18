import assert from 'node:assert/strict';
import test from 'node:test';
import { assertStaticPackageDependencies } from './catalog-static-package.mjs';
const desktop = [{ type: 'desktop-window' }];
test('desktop catalog admission rejects unresolved runtime and workspace dependencies', () => {
  assert.doesNotThrow(() => assertStaticPackageDependencies({ devDependencies: { sdk: '0.1.0-beta.11' } }, desktop));
  for (const dependencies of ['dependencies', 'optionalDependencies']) {
    assert.throws(() => assertStaticPackageDependencies({ [dependencies]: { arbitrary: '1.0.0' } }, desktop));
  }
  assert.throws(() => assertStaticPackageDependencies({ devDependencies: { sdk: 'workspace:*' } }, desktop));
});
test('existing editor providers retain their exact published runtime closure', () => {
  assert.doesNotThrow(() => assertStaticPackageDependencies({ dependencies: { contract: '0.1.0-beta.15' } }, [{ type: 'content-editor-provider' }]));
});
