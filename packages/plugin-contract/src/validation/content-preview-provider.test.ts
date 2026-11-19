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

const editor = {
  type: 'content-editor-provider',
  id: 'genoffice-docx',
  mediaTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  surface: { ...preview.surface, entrypoint: 'index.html' },
  bridgeVersion: '1.0.0',
  operations: ['load', 'settle', 'comment', 'tracked-change'],
};

function manifest(...contributions: (typeof preview | typeof editor)[]) {
  if (contributions.length === 0) contributions = [preview];
  return {
    pluginId: 'dev.clowder.genoffice-docx',
    name: 'GenOffice',
    version: '0.1.0-alpha.4',
    contractVersion: '0.1.0',
    runtime: { transport: 'builtin' },
    contributions,
    features: contributions.map(({ id, type }) => ({
      id,
      name: id,
      resources: [],
      contributions: [{ type, id }],
    })),
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

test('rejects an extension declared twice even when the MIME or provider differs', () => {
  const alternatePdf = { extension: 'pdf', mediaType: 'application/x-pdf' };
  const repeated = { ...preview, formats: [...preview.formats, alternatePdf] };
  const other = { ...preview, id: 'other-preview', formats: [alternatePdf] };

  for (const value of [manifest(repeated), manifest(preview, other)]) {
    const result = validateManifest(value);
    assert.ok(!result.valid);
    assert.ok(result.errors.some((error) => error.keyword === 'unambiguousFormats'));
  }
});

test('bounds a preview provider to 64 declared formats', () => {
  const formats = Array.from({ length: 65 }, (_, index) => ({
    extension: 'format' + index,
    mediaType: 'application/octet-stream',
  }));
  assert.ok(validateManifest(manifest({ ...preview, formats: formats.slice(0, 64) })).valid);
  assert.equal(validateManifest(manifest({ ...preview, formats })).valid, false);
});

test('keeps DOCX on its editor while admitting separate PDF and PPTX previews', () => {
  assert.ok(validateManifest(manifest(editor, preview)).valid);
  const formats = [{ extension: 'docx', mediaType: editor.mediaTypes[0]! }];
  assert.equal(validateManifest(manifest(editor, { ...preview, formats })).valid, false);
  assert.equal(validateManifest(manifest({ ...preview, formats })).valid, false);
});
