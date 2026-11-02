// Retain a built Cat Cafe Client only after checking every source input against an exact Git commit.
// Usage: node docs/evidence/f290-share-collective/retain-client-assets.mjs <clean-source-root> <full-head-sha>
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const [sourceRootArg, expectedHead] = process.argv.slice(2);
assert.ok(sourceRootArg && /^[0-9a-f]{40}$/.test(expectedHead ?? ''), 'source root and full Git SHA are required');
const sourceRoot = path.resolve(sourceRootArg);
const clientRoot = path.join(sourceRoot, 'packages/collective-client');
const dist = path.join(clientRoot, 'dist');
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const destination = path.join(repoRoot, 'packages/collective-connector/assets/client');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const git = (args, options = {}) => execFileSync('git', args, { cwd: sourceRoot, ...options });

assert.equal(git(['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), expectedHead, 'unexpected Client source HEAD');
assert.equal(git(['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim(), '', 'tracked source has local changes');
assert.match(git(['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim(),
  /^(?:https:\/\/github\.com\/|git@github\.com:)zts212653\/cat-cafe(?:\.git)?$/u,
  'unexpected Client source repository');
const buildInputsBytes = await readFile(path.join(dist, 'build-inputs.json'));
const manifestBytes = await readFile(path.join(dist, 'manifest.json'));
const buildInputs = JSON.parse(buildInputsBytes);
const manifest = JSON.parse(manifestBytes);
assert.equal(buildInputs.version, 1);
assert.equal(manifest.version, 1);
assert.equal(manifest.clientBuildId, 'collective-client-v2');

const dependencyInputs = buildInputs.inputs.filter((input) => input.path.includes('/node_modules/.pnpm/'));
const sourceInputs = buildInputs.inputs.filter((input) => !input.path.includes('/node_modules/.pnpm/'));
for (const input of buildInputs.inputs) {
  const absolute = path.resolve(clientRoot, input.path);
  assert.ok(absolute.startsWith(sourceRoot + path.sep), 'Client input escapes source root: ' + input.path);
  assert.equal(sha256(await readFile(absolute)), input.sha256, 'built input changed: ' + input.path);
}

// Compare tracked input bytes with Git itself, including binary source inputs.
const sourcePaths = sourceInputs.map((input) => path.relative(sourceRoot, path.resolve(clientRoot, input.path)));
const input = sourcePaths.map((name) => expectedHead + ':' + name).join('\n') + '\n';
const batch = git(['cat-file', '--batch'], { input, maxBuffer: 64 * 1024 * 1024 });
let offset = 0;
for (const [index, entry] of sourceInputs.entries()) {
  const end = batch.indexOf(10, offset);
  assert.ok(end >= offset, 'missing Git object header');
  const header = batch.subarray(offset, end).toString('utf8');
  const match = /^[a-f0-9]+ blob ([0-9]+)$/.exec(header);
  assert.ok(match, 'source input is not a tracked blob: ' + sourcePaths[index]);
  const size = Number(match[1]);
  const bytes = batch.subarray(end + 1, end + 1 + size);
  assert.equal(sha256(bytes), entry.sha256, 'source differs from exact commit: ' + sourcePaths[index]);
  offset = end + 1 + size + 1;
}
assert.equal(offset, batch.length, 'unexpected Git object batch data');

const sanitizerVersions = new Set(dependencyInputs.flatMap((entry) => {
  const match = /\/\.pnpm\/dompurify@([^/]+)\/node_modules\/dompurify\//.exec(entry.path);
  return match ? [match[1]] : [];
}));
assert.equal(sanitizerVersions.size, 1, 'expected one locked DOMPurify version');
const sanitizerVersion = [...sanitizerVersions][0];
const lockBytes = git(['show', expectedHead + ':pnpm-lock.yaml']);
const lock = parseYaml(lockBytes.toString('utf8'));
assert.equal(lock.importers?.['packages/ui']?.dependencies?.dompurify?.version, sanitizerVersion,
  'DOMPurify does not match the packages/ui source-lock binding');

for (const file of manifest.files) {
  assert.ok(file.path.startsWith('/') && !file.path.includes('..'), 'invalid retained asset path');
  const bytes = await readFile(path.join(dist, file.path.slice(1)));
  assert.equal(bytes.length, file.size, 'asset size mismatch: ' + file.path);
  assert.equal(sha256(bytes), file.sha256, 'asset digest mismatch: ' + file.path);
}
const source = {
  repository: 'zts212653/cat-cafe',
  sourceBaseHead: expectedHead,
  sourceState: 'exact-source-head',
  package: 'packages/collective-client',
  buildEntrypoint: 'packages/collective-client/scripts/build.mjs#buildRetainedClient',
  assetDigest: sha256(JSON.stringify(manifest.files.map(({ path: filePath, size, sha256: hash }) => ({ path: filePath, size, sha256: hash })))),
  buildInputsSha256: sha256(buildInputsBytes),
  manifestSha256: sha256(manifestBytes),
  inputOverrides: [],
  dependencyInputs: 'build-inputs.json',
  sourceCheckedInputCount: sourceInputs.length,
  dependencyInputCount: dependencyInputs.length,
  totalInputCount: buildInputs.inputs.length,
  sourceLockfileSha256: sha256(lockBytes),
  sourceLockBindings: { 'packages/ui:dompurify': sanitizerVersion },
};

await mkdir(destination, { recursive: true });
for (const name of ['index.html', 'manifest.json', 'build-inputs.json', ...manifest.files.map((file) => file.path.slice(1))]) {
  const target = path.join(destination, name);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(dist, name), target);
}
await writeFile(path.join(destination, 'source.json'), JSON.stringify(source, null, 2) + '\n');
console.log(JSON.stringify({ sourceHead: expectedHead, sourceInputs: sourceInputs.length, dependencyInputs: dependencyInputs.length, assetDigest: source.assetDigest }));
