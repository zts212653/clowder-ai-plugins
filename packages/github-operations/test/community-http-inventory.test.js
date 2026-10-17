import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { validateManifest } from '@clowder-ai/plugin-contract';

test('all 33 migrated Community HTTP declarations are declared by the production manifest', () => {
  const inventory = JSON.parse(readFileSync(new URL('../../../migration/f202-w3-community-http-routes.json', import.meta.url), 'utf8'));
  const manifest = parse(readFileSync(new URL('../plugin.yaml', import.meta.url), 'utf8'));
  assert.equal(inventory.routes.length, 33);
  const declarations = manifest.contributions.filter(c => c.type === 'webhook' && c.action.method === inventory.handler);
  assert.equal(declarations.length, 29);
  assert.deepEqual(declarations.flatMap(c => c.methods.map(method => `${method} ${c.path}`)).sort(),
    inventory.routes.map(r => `${r.method} ${r.pluginPath}`).sort());
  assert.ok(declarations.every(c => c.verificationSecretRef === undefined &&
    manifest.features[0].contributions.some(r => r.type === 'webhook' && r.id === c.id)));
  assert.equal(manifest.contributions.some(c => c.type === 'tool' && c.action.method === inventory.handler), false);
  const result = validateManifest(manifest);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});
