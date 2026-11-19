import assert from 'node:assert/strict';
import test from 'node:test';

import { validateManifest } from './manifest.js';

const preview = {
  type: 'content-preview-provider',
  id: 'genoffice-preview',
  formats: [
    { extension: 'pdf', mediaType: 'application/pdf' },
    { extension: 'pptx', mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  ],
  surface: {
    entrypoint: 'preview/index.html',
    integrity: `sha256-${'A'.repeat(43)}=`,
    sandbox: 'dedicated-origin-iframe',
    navigationPolicy: 'navigation-api-deny',
  },
  bridgeVersion: '1.0.0',
};

function manifest(contribution = preview) {
  return {
    pluginId: 'dev.clowder.genoffice-docx',
    name: 'GenOffice',
    version: '0.1.0-alpha.4',
    contractVersion: '0.1.0',
    runtime: { transport: 'builtin' },
    contributions: [contribution],
    features: [{
      id: 'preview-office',
      name: 'Preview Office files',
      resources: [],
      contributions: [{ type: contribution.type, id: contribution.id }],
    }],
  };
}

test('admits a static read-only provider declaring formats outside the Host', () => {
  const value = manifest();
  const result = validateManifest(value);
  assert.ok(result.valid, JSON.stringify(result));
  assert.deepEqual(result.manifest.contributions, value.contributions);
});

test('a preview provider cannot declare editor capabilities or a different iframe boundary', () => {
  const editor = { ...preview, operations: ['load', 'settle'] };
  const unsandboxed = { ...preview, surface: { ...preview.surface, sandbox: 'none' } };
  const wildcard = { ...preview, formats: [{ extension: 'pdf', mediaType: 'application/*' }] };
  assert.equal(validateManifest(manifest(editor)).valid, false);
  assert.equal(validateManifest(manifest(unsandboxed)).valid, false);
  assert.equal(validateManifest(manifest(wildcard)).valid, false);
});
