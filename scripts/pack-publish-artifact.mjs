import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      [command, ...args, result.stdout, result.stderr].filter(Boolean).join('\n'),
    );
  }
  return result.stdout;
}

function isContained(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function readPnpmArtifact(output) {
  const artifact = JSON.parse(output);
  if (
    artifact === null ||
    Array.isArray(artifact) ||
    typeof artifact !== 'object' ||
    typeof artifact.filename !== 'string' ||
    typeof artifact.name !== 'string' ||
    typeof artifact.version !== 'string' ||
    !Array.isArray(artifact.files)
  ) {
    throw new Error('pnpm pack did not report one materialized artifact');
  }
  return artifact;
}

function assertCanonicalArchiveMembers(output) {
  const members = output.split('\n').filter(Boolean);
  if (members.length === 0) throw new Error('materialized package archive is empty');
  for (const member of members) {
    const normalized = posix.normalize(member.replace(/\/$/u, ''));
    if (
      member.includes('\\') ||
      isAbsolute(member) ||
      normalized === '.' ||
      normalized === '..' ||
      normalized.startsWith('../') ||
      (normalized !== 'package' && !normalized.startsWith('package/'))
    ) {
      throw new Error(`materialized package archive has an unsafe member: ${member}`);
    }
  }
}

async function assertPhysicalTree(root) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    for (const entry of await readdir(directory)) {
      const path = join(directory, entry);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        throw new Error(`materialized package contains a symlink: ${relative(root, path)}`);
      }
      if (stat.isDirectory()) pending.push(path);
      else if (!stat.isFile()) {
        throw new Error(`materialized package contains a non-regular entry: ${relative(root, path)}`);
      }
    }
  }
}

async function main() {
  const [packageDirectory, destination] = process.argv.slice(2);
  if (!/^packages\/[a-z0-9-]+$/u.test(packageDirectory ?? '')) {
    throw new Error('package directory must be a repository-relative packages/<name> path');
  }
  if (typeof destination !== 'string' || destination.length === 0) {
    throw new Error('pack destination is required');
  }

  const packageRoot = resolve(repoRoot, packageDirectory);
  const destinationRoot = resolve(destination);
  if (!isContained(resolve(repoRoot, 'packages'), packageRoot)) {
    throw new Error('package directory escapes the public package root');
  }
  await mkdir(destinationRoot, { recursive: true });

  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const bundled = packageJson.bundledDependencies;
  if (bundled === undefined || (Array.isArray(bundled) && bundled.length === 0)) {
    process.stdout.write(
      run(
        'npm',
        ['pack', '--json', '--ignore-scripts', '--pack-destination', destinationRoot, packageRoot],
        repoRoot,
      ),
    );
    return;
  }
  if (!Array.isArray(bundled) || !bundled.every(name => typeof name === 'string')) {
    throw new Error('bundledDependencies must be an explicit package-name array');
  }
  const dependencies = Object.keys(packageJson.dependencies ?? {}).sort();
  const bundledNames = [...bundled].sort();
  if (JSON.stringify(dependencies) !== JSON.stringify(bundledNames)) {
    throw new Error('runtime package must bundle its complete declared dependency closure');
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'clowder-pack-closure-'));
  try {
    const sourceRoot = join(temporaryRoot, 'source');
    await mkdir(sourceRoot);
    const pnpmOutput = run(
      'pnpm',
      [
        '--config.ignore-scripts=true',
        '--config.node-linker=hoisted',
        'pack',
        '--json',
        '--pack-destination',
        destinationRoot,
      ],
      packageRoot,
    );
    const materialized = readPnpmArtifact(pnpmOutput);
    const archivePath = resolve(packageRoot, materialized.filename);
    if (!isContained(destinationRoot, archivePath)) {
      throw new Error('pnpm pack artifact escaped its requested destination');
    }
    assertCanonicalArchiveMembers(run('tar', ['-tzf', archivePath], repoRoot));
    run('tar', ['-xzf', archivePath, '-C', sourceRoot], repoRoot);

    const stagedPackageRoot = join(sourceRoot, 'package');
    await assertPhysicalTree(stagedPackageRoot);
    const bytes = await readFile(archivePath);
    process.stdout.write(`${JSON.stringify([{
      ...materialized,
      filename: basename(archivePath),
      size: bytes.byteLength,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      shasum: createHash('sha1').update(bytes).digest('hex'),
    }], null, 2)}\n`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
