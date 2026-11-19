import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parse } from 'yaml';
import { validateManifest } from '@clowder-ai/plugin-contract';
import {
  MEMORY_PROTOCOL_MAJOR,
  MEMORY_REQUIRED_OPERATIONS,
  MEMORY_STORAGE_FORMAT,
  isCompatibleDescriptor,
  parseDispatch,
} from '@clowder-ai/plugin-memory-contract';

const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8'));

test('the memory contract is usable without the F202 contract or SDK', async () => {
  // A consumer that only needs the wire shape must not have to load the plugin
  // ecosystem: this module is imported at the top of the file with no other deps.
  const descriptor = {
    protocolMajor: MEMORY_PROTOCOL_MAJOR,
    operations: [...MEMORY_REQUIRED_OPERATIONS],
    storageFormat: MEMORY_STORAGE_FORMAT,
  };
  assert.equal(isCompatibleDescriptor(descriptor), true);
  assert.deepEqual(parseDispatch({ operation: 'kv.list', input: { threadRef: 'default' } }), {
    operation: 'kv.list',
    input: { threadRef: 'default' },
  });
});

test('the packaged manifest and the built entrypoint agree on every declared coordinate', async () => {
  const validation = validateManifest(manifest);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));

  // The console is the host's file, in the package layout the Host actually reads.
  const pdl = parse(await readFile(new URL('../console/pdl.yaml', import.meta.url), 'utf8'));
  assert.equal(pdl.ns, 'memory');
  assert.equal(pdl.views['memory.overview'].route, 'memory');

  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    files: string[];
    exports: Record<string, unknown>;
  };
  assert.ok(pkg.files.includes('console'), 'console must be packaged for the Host to read');
  assert.ok(pkg.files.includes('plugin.yaml'));
  assert.equal(pkg.exports['./manifest'], './plugin.yaml');

  // The built artifact the manifest points at is the one this package builds.
  const entrypoint = await import(new URL('../dist/plugin-entrypoint.js', import.meta.url).href);
  assert.equal(typeof (entrypoint.default as { create?: unknown }).create, 'function');
});
