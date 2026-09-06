import assert from 'node:assert/strict';
import test from 'node:test';
import { validateManifest } from '../validation/manifest.js';

const sri = `sha256-${'A'.repeat(43)}=`;
const declaration = {
  executionClass: 'dedicated-browser-worker',
  entrypoint: 'semantic/worker.js',
  integrity: sri,
  protocolVersion: '1.0.0',
};
function manifest(semanticMaterializer?: unknown) {
  return {
    pluginId: 'test.document-editor', version: '0.1.0-alpha.0', contractVersion: '0.1.0', name: 'Document editor',
    runtime: { transport: 'builtin' },
    features: [{ id: 'docx', name: 'DOCX', resources: [], capabilities: [], contributions: [{ type: 'content-editor-provider', id: 'docx' }] }],
    contributions: [{
      type: 'content-editor-provider', id: 'docx',
      mediaTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      surface: { entrypoint: 'renderer/index.html', integrity: sri, sandbox: 'dedicated-origin-iframe', navigationPolicy: 'navigation-api-deny' },
      bridgeVersion: '1.0.0', operations: ['load', 'settle', 'comment', 'tracked-change'],
      ...(semanticMaterializer === undefined ? {} : { semanticMaterializer }),
    }],
  };
}

test('static editor compatibility and an explicitly declared independent materializer are distinct valid shapes', () => {
  assert.equal(validateManifest(manifest()).valid, true);
  assert.equal(validateManifest(manifest(declaration)).valid, true);
});

for (const [field, value] of [
  ['executionClass', 'node'], ['entrypoint', '../escape.js'], ['entrypoint', 'file:///tmp/worker.js'],
  ['entrypoint', 'https://remote.example/worker.js'], ['entrypoint', 'semantic/worker.html'],
  ['integrity', 'sha256-unknown'], ['protocolVersion', '2.0.0'], ['permissions', ['network']],
] as const) {
  test(`materializer rejects ${field}=${JSON.stringify(value)}`, () => {
    assert.equal(validateManifest(manifest({ ...declaration, [field]: value })).valid, false);
  });
}
