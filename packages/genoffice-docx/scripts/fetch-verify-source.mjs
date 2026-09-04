import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertArchiveEntries,
  assertExtractedSource,
  sha256Hex,
} from '../dist/source-policy.js';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const lock = JSON.parse(await readFile(join(packageRoot, 'source-lock.json'), 'utf8'));
const stagingRoot = join(packageRoot, '.tmp');
const archivePath = join(stagingRoot, `${lock.tag}.tar.gz`);
const extractParent = join(stagingRoot, 'source');
const sourceRoot = join(extractParent, lock.rootDirectory);

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function tarType(mode) {
  if (mode === '-') return 'file';
  if (mode === 'd') return 'directory';
  if (mode === 'l') return 'symbolic-link';
  if (mode === 'h') return 'hard-link';
  return 'other';
}

await mkdir(stagingRoot, { recursive: true });
const response = await fetch(lock.archiveUrl, {
  redirect: 'follow',
  headers: { 'user-agent': 'clowder-ai-genoffice-source-admission/0.1' },
});
if (!response.ok) throw new Error(`source download failed: HTTP ${response.status}`);
const archive = Buffer.from(await response.arrayBuffer());
const archiveDigest = sha256Hex(archive);
if (archiveDigest !== lock.archiveSha256) {
  throw new Error(
    `source archive digest mismatch: expected ${lock.archiveSha256}, got ${archiveDigest}`,
  );
}
await writeFile(archivePath, archive, { mode: 0o600 });

const names = run('tar', ['-tzf', archivePath]).trimEnd().split('\n');
const verbose = run('tar', ['-tvzf', archivePath]).trimEnd().split('\n');
if (names.length !== verbose.length) throw new Error('tar listing shape mismatch');
const entries = names.map((path, index) => ({
  path,
  type: tarType(verbose[index]?.[0] ?? '?'),
}));
assertArchiveEntries(entries, lock.rootDirectory, { allowExcludedEnterprise: true });

await rm(extractParent, { recursive: true, force: true });
await mkdir(extractParent, { recursive: true });
run('tar', [
  '-xzf',
  archivePath,
  '-C',
  extractParent,
  '--no-same-owner',
  '--no-same-permissions',
  '--exclude',
  `${lock.rootDirectory}/ee`,
  '--exclude',
  `${lock.rootDirectory}/ee/*`,
]);
await assertExtractedSource(sourceRoot, lock);
process.stdout.write(
  `${JSON.stringify({ sourceRoot, archiveSha256: archiveDigest, commit: lock.commit })}\n`,
);
