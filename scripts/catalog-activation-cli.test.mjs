import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parsePluginSelectorArgument } from './catalog-activation.mjs';

test('scoped catalog commands do not reintroduce the full publication batch as a prerequisite', async () => {
  const workspace = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  for (const name of ['catalog:activation-check:plugin', 'catalog:activate:plugin']) {
    const command = workspace.scripts[name];
    assert.match(command, /pnpm --filter @clowder-ai\/plugin-contract build/u);
    assert.doesNotMatch(command, /catalog:check/u);
  }
  assert.match(workspace.scripts['catalog:activation-check:plugin'], /--check-plugin-activation/u);
  assert.match(workspace.scripts['catalog:activate:plugin'], /--activate-plugin/u);
});

test('scoped command parsing accepts ordinary and pnpm separator forms only', () => {
  assert.equal(parsePluginSelectorArgument(['official.example'], 'usage'), 'official.example');
  assert.equal(parsePluginSelectorArgument(['--', 'official.example'], 'usage'), 'official.example');
  assert.throws(() => parsePluginSelectorArgument([], 'usage'), /usage/u);
  assert.throws(
    () => parsePluginSelectorArgument(['official.example', 'official.sibling'], 'usage'),
    /usage/u,
  );
});
