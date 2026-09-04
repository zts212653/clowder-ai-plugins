import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { validateManifest } from '@clowder-ai/plugin-contract';
import { parse as parseYaml } from 'yaml';

import {
  assertArchiveEntries,
  assertExtractedSource,
  sha256Hex,
  type SourceLock,
} from './source-policy.js';

const packageRoot = join(import.meta.dirname, '..');

test('freezes the exact public GenOffice source and a valid provider manifest', async () => {
  const lock = JSON.parse(
    await readFile(join(packageRoot, 'source-lock.json'), 'utf8'),
  ) as SourceLock;
  assert.deepEqual(lock, {
    repository: 'https://github.com/genspark-ai/genoffice.git',
    tag: 'v0.8.1039',
    commit: 'e833fff87f5628cc681e0fd1a063ce64fde5baa4',
    tree: 'b6e5133dbd19a6a501db31c389cf114dac98677a',
    archiveUrl:
      'https://codeload.github.com/genspark-ai/genoffice/tar.gz/refs/tags/v0.8.1039',
    archiveSha256: 'e57a238b99dc7a1908099957157b40929026c8d3dfac4d5e6dc1d8efee2deee9',
    rootDirectory: 'genoffice-0.8.1039',
    files: {
      'package-lock.json':
        '6c21803656a8251c93441310b90e6b63c434fc7ecb5006687cfb11ed95daf9a9',
      LICENSE: '68e32334df324ef4fc79fad3a26487e5abac36055a484bb6c8d7ecf9d8350885',
      NOTICE: 'ff1ad79ed52b0f5c1d0e10a9370c22c0c0e6ee83074b6a9b644b25ab7b129f94',
    },
  });

  const manifest = parseYaml(await readFile(join(packageRoot, 'plugin.yaml'), 'utf8'));
  const result = validateManifest(manifest);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(manifest.contributions[0].type, 'content-editor-provider');
  assert.equal(manifest.contributions[0].surface.sandbox, 'dedicated-origin-iframe');
});

test('archive admission rejects traversal, links, and enterprise source before extraction', () => {
  assert.doesNotThrow(() =>
    assertArchiveEntries(
      [
        { path: 'genoffice-0.8.1039/', type: 'directory' },
        { path: 'genoffice-0.8.1039/apps/docs/src/renderer/main.tsx', type: 'file' },
      ],
      'genoffice-0.8.1039',
    ),
  );
  assert.throws(
    () =>
      assertArchiveEntries(
        [{ path: 'genoffice-0.8.1039/ee/private.ts', type: 'file' }],
        'genoffice-0.8.1039',
      ),
    /enterprise/i,
  );
  assert.throws(
    () => assertArchiveEntries([{ path: '../escape', type: 'file' }], 'genoffice-0.8.1039'),
    /archive root/i,
  );
  assert.throws(
    () =>
      assertArchiveEntries(
        [{ path: 'genoffice-0.8.1039/link', type: 'symbolic-link' }],
        'genoffice-0.8.1039',
      ),
    /link/i,
  );
});

test('post-extraction verification binds exact file digests and rejects ee', async () => {
  const root = await mkdtemp(join(tmpdir(), 'genoffice-source-policy-'));
  await mkdir(join(root, 'genoffice-0.8.1039'), { recursive: true });
  const extracted = join(root, 'genoffice-0.8.1039');
  await writeFile(join(extracted, 'package-lock.json'), 'lock');
  await writeFile(join(extracted, 'LICENSE'), 'license');
  await writeFile(join(extracted, 'NOTICE'), 'notice');
  const lock: SourceLock = {
    repository: 'https://example.invalid/repo.git',
    tag: 'v1.0.0',
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    archiveUrl: 'https://example.invalid/v1.0.0.tar.gz',
    archiveSha256: 'c'.repeat(64),
    rootDirectory: 'genoffice-0.8.1039',
    files: {
      'package-lock.json': sha256Hex(Buffer.from('lock')),
      LICENSE: sha256Hex(Buffer.from('license')),
      NOTICE: sha256Hex(Buffer.from('notice')),
    },
  };
  await assertExtractedSource(extracted, lock);

  await mkdir(join(extracted, 'node_modules', '.bin'), { recursive: true });
  await symlink('../tool/index.js', join(extracted, 'node_modules', '.bin', 'tool'));
  await assertExtractedSource(extracted, lock);

  await mkdir(join(extracted, 'ee'));
  await assert.rejects(assertExtractedSource(extracted, lock), /enterprise/i);
});
