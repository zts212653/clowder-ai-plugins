import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));

test('standard dependency installation restores retained local directory graphs', async () => {
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.postinstall, 'node scripts/prepare-retained-directory-graphs.mjs');
});

test('effective source locks and physical links preserve exact production dependency versions', async () => {
  const workspace = parse(await readFile(resolve(root, 'pnpm-lock.yaml'), 'utf8'));
  const mismatches = [];
  for (const [importer, original] of Object.entries(workspace.importers)) {
    let entry = original;
    let directory = resolve(root, importer);
    try {
      const local = parse(await readFile(resolve(directory, 'pnpm-lock.yaml'), 'utf8'));
      entry = local.importers['.'];
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const [name, edge] of Object.entries({ ...entry.dependencies, ...entry.optionalDependencies })) {
      if (!edge.version.startsWith('link:') || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(edge.specifier)) continue;
      const target = resolve(directory, edge.version.slice('link:'.length));
      const observed = JSON.parse(await readFile(resolve(directory, 'node_modules', name, 'package.json'), 'utf8'));
      if (observed.name !== name || observed.version !== edge.specifier ||
          await realpath(resolve(directory, 'node_modules', name)) !== await realpath(target)) {
        mismatches.push({ importer, name, requested: edge.specifier, observed: observed.version });
      }
    }
  }
  assert.deepEqual(mismatches, [], 'a source directory must match its selected lock after dependency installation');
});
