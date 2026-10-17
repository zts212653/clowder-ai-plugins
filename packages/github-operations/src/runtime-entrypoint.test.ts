import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

test('the shipped GitHub manifest selects an independently loadable builtin module', async () => {
  const root = new URL('../', import.meta.url);
  const manifest = parse(await readFile(new URL('plugin.yaml', root), 'utf8'));
  const entrypoint = new URL(manifest.runtime.entrypoint, root);
  await assert.doesNotReject(access(entrypoint), 'the declared runtime must exist in the built package');
  assert.equal(manifest.runtime.transport, 'builtin');
  const module = await import(entrypoint.href);
  assert.equal(typeof module.default?.create, 'function');
  const runtime = module.default.create(manifest);
  assert.equal(typeof runtime.start, 'function');
});
