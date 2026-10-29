import assert from 'node:assert/strict';
import test from 'node:test';
import { validateManifest } from './manifest.js';

const manifest = () => ({
  pluginId: 'fixture.shared', version: '0.1.0', contractVersion: '0.3.2-candidate.0', name: 'Shared MCP',
  runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js' },
  contributions: [{ type: 'mcp', id: 'native', runtime: { transport: 'stdio', entrypoint: 'dist/stdio.js' },
    sharedFactory: { module: 'dist/mcp-server.js', export: 'createMcpServer' } }],
  features: [{ id: 'shared', name: 'Shared', resources: [], contributions: [{ type: 'mcp', id: 'native' }] }],
});

test('admits an explicit package-local factory while retaining the original stdio contribution', () => {
  const accepted = validateManifest(manifest());
  assert.equal(accepted.valid, true, JSON.stringify(accepted));
});

test('every shared factory retains a stdio contribution for explicit fallback', () => {
  const value = manifest();
  value.contributions[0]!.runtime.transport = 'ipc';
  const rejected = validateManifest(value);
  assert.equal(rejected.valid, false, 'IPC cannot replace the promised stdio fallback');
  assert.equal(rejected.errors[0]?.keyword, 'sharedFactoryBoundary');
  const legacy = { ...value, contributions: value.contributions.map(({ sharedFactory: _factory, ...contribution }) => contribution) };
  assert.equal(validateManifest(legacy).valid, true, 'the new factory boundary does not retire existing IPC declarations');
  // Also check a later contribution: a valid first factory cannot hide an IPC one.
  const multiple = manifest();
  multiple.contributions.push({ ...multiple.contributions[0]!, id: 'second', runtime: { transport: 'ipc', entrypoint: 'dist/ipc.js' } });
  assert.equal(validateManifest(multiple).valid, false);
});

test('factory admission rejects traversal, missing module runtime and undeclared factory inputs', () => {
  for (const module of ['../escape.js', '/tmp/escape.js', 'dist/../../escape.js']) {
    const value = manifest(); value.contributions[0]!.sharedFactory.module = module;
    assert.equal(validateManifest(value).valid, false, module);
  }
  const external = manifest(); external.runtime.transport = 'stdio';
  assert.equal(validateManifest(external).valid, false, 'external plugin code cannot enter the Host process');
  const unknown = manifest(); Object.assign(unknown.contributions[0]!.sharedFactory, { environment: {} });
  assert.equal(validateManifest(unknown).valid, false);
  const old = manifest(); old.contractVersion = '0.3.1-candidate.0';
  assert.equal(validateManifest(old).valid, false, 'an old Host requirement cannot promise the new field');
});
