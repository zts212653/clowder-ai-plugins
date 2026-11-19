import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { validateManifest } from '../../plugin-contract/dist/index.js';
import { parse as parseYaml } from 'yaml';

const packageRoot = join(import.meta.dirname, '..');
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF = 'application/pdf';

test('preview contribution coexists with the unchanged DOCX editor', async () => {
  const manifest = parseYaml(await readFile(join(packageRoot, 'plugin.yaml'), 'utf8')) as {
    contributions: Array<Record<string, unknown>>;
  };
  const result = validateManifest(manifest);
  assert.equal(result.valid, true, JSON.stringify(result.errors));

  const editor = manifest.contributions.find((item) => item.type === 'content-editor-provider');
  assert.ok(editor, 'DOCX editor contribution must stay declared');
  assert.deepEqual(editor.mediaTypes, [DOCX]);
  assert.deepEqual(editor.operations, ['load', 'settle', 'comment', 'tracked-change']);

  const preview = manifest.contributions.find((item) => item.id === 'genoffice-preview');
  assert.ok(preview, 'preview contribution must be declared');
  assert.equal(preview.type, 'content-preview-provider');
  assert.ok(Array.isArray(preview.formats));
  assert.deepEqual(preview.formats[0], { extension: 'pdf', mediaType: PDF });
  assert.equal('operations' in preview, false);
  assert.equal('semanticMaterializer' in preview, false);
  const surface = preview.surface as Record<string, unknown>;
  assert.equal(surface.entrypoint, 'renderer/preview/index.html');
  assert.equal(surface.sandbox, 'dedicated-origin-iframe');
  assert.equal(surface.navigationPolicy, 'navigation-api-deny');
  assert.match(String(surface.integrity), /^sha256-[A-Za-z0-9+/]{43}=$/);
  assert.equal(preview.bridgeVersion, '1.0.0');
});
