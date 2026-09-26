import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertProductionDependencyClosure } from './catalog-package-shrinkwrap.mjs';
import {
  assertPackageArchiveLayout,
  verifySelfContainedArchive,
} from './verify-self-contained-artifact.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, NODE_ENV: 'development' },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error([command, ...args, result.stdout, result.stderr].filter(Boolean).join('\n'));
  }
  return result.stdout;
}

function artifactBase(name, version) {
  assert.match(name, /^@[a-z0-9-]+\/[a-z0-9-]+$/u);
  assert.match(version, /^[0-9A-Za-z.-]+$/u);
  return `${name.slice(1).replace('/', '-')}-${version}`;
}

function packCheckoutPackage(directory, destination) {
  const output = run('npm', [
    'pack', '--json', '--ignore-scripts', '--pack-destination', destination,
    join(repoRoot, 'packages', directory),
  ], destination);
  const [artifact] = JSON.parse(output);
  assert.equal(typeof artifact?.filename, 'string');
  return join(destination, artifact.filename);
}

export async function publishImmutableArtifact(candidate, destination) {
  const pending = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
  try {
    await copyFile(candidate, pending);
    // Hard-link publication is atomic and fails with EEXIST instead of
    // replacing any existing artifact, including identical bytes.
    await link(pending, destination);
  } finally {
    await rm(pending, { force: true });
  }
}

async function main() {
  const [packageDirectory, artifactRootArg] = process.argv.slice(2);
  if (!/^packages\/[a-z0-9-]+$/u.test(packageDirectory ?? '') || !artifactRootArg) {
    throw new Error('usage: node scripts/pack-self-contained-artifact.mjs packages/<name> <f202-w1-tarballs-directory>');
  }
  const artifactRoot = await realpath(resolve(artifactRootArg));
  if (basename(artifactRoot) !== 'f202-w1-tarballs') {
    throw new Error('output root must be the f202-w1-tarballs directory');
  }
  const outputDirectory = join(artifactRoot, 'self-contained');
  const outputStat = await lstat(outputDirectory);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) {
    throw new Error('self-contained output must be a physical directory');
  }

  const sourcePackage = JSON.parse(await readFile(join(repoRoot, packageDirectory, 'package.json'), 'utf8'));
  const base = artifactBase(sourcePackage.name, sourcePackage.version);
  const canonicalArchive = join(artifactRoot, `${base}.tgz`);
  if (!(await lstat(canonicalArchive)).isFile()) throw new Error('canonical input must be a regular tarball');
  assertPackageArchiveLayout(canonicalArchive);

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'clowder-self-contained-build-'));
  try {
    const stageRoot = join(temporaryRoot, 'stage');
    const packRoot = join(temporaryRoot, 'local-packs');
    await mkdir(stageRoot);
    await mkdir(packRoot);
    run('tar', ['-xzf', canonicalArchive, '-C', stageRoot], temporaryRoot);
    const stagedPackage = join(stageRoot, 'package');
    const stagedManifestPath = join(stagedPackage, 'package.json');
    const stagedManifestBytes = await readFile(stagedManifestPath);
    const stagedManifest = JSON.parse(stagedManifestBytes.toString('utf8'));
    assert.equal(stagedManifest.name, sourcePackage.name, 'canonical package name differs from checkout');
    assert.equal(stagedManifest.version, sourcePackage.version, 'canonical package version differs from checkout');
    const shrinkwrap = JSON.parse(await readFile(join(stagedPackage, 'npm-shrinkwrap.json'), 'utf8'));
    assertProductionDependencyClosure(stagedManifest, shrinkwrap);

    // Dev-wave SDK and contract bytes always come from this checkout, even if
    // packages with the same versions later become available in the registry.
    const localPacks = [];
    if (shrinkwrap.packages['node_modules/@clowder-ai/plugin-contract']) {
      run('pnpm', ['--filter', '@clowder-ai/plugin-contract', 'build'], repoRoot);
      localPacks.push(packCheckoutPackage('plugin-contract', packRoot));
    }
    if (shrinkwrap.packages['node_modules/@clowder-ai/plugin-sdk']) {
      run('pnpm', ['--filter', '@clowder-ai/plugin-sdk', 'build'], repoRoot);
      localPacks.push(packCheckoutPackage('plugin-sdk', packRoot));
    }

    await mkdir(join(stagedPackage, 'node_modules'), { recursive: true });
    // npm resolves dev dependencies into its ideal tree even with --omit=dev.
    // A dev-only version can then displace the publisher-locked production
    // transitive version. Install from a production-only temporary manifest,
    // then restore the exact canonical manifest bytes before archiving.
    const installManifest = { ...stagedManifest };
    delete installManifest.devDependencies;
    await writeFile(stagedManifestPath, `${JSON.stringify(installManifest, null, 2)}\n`);
    run('npm', [
      'install', '--omit=dev', '--ignore-scripts', '--no-save', '--package-lock=false',
      '--no-bin-links', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org',
      ...localPacks,
    ], stagedPackage);
    await writeFile(stagedManifestPath, stagedManifestBytes);

    const candidate = join(temporaryRoot, 'candidate.tgz');
    run('tar', [
      '--exclude=package/node_modules/.package-lock.json',
      '-czf', candidate, '-C', stageRoot, 'package',
    ], temporaryRoot);
    const verification = await verifySelfContainedArchive(candidate);
    const digest = createHash('sha256').update(await readFile(candidate)).digest('hex');
    // The checksum is part of the dev-wave coordinate: a rebuild must never
    // silently replace bytes already handed to a Host consumer.
    const filename = `${base}-${process.platform}-${process.arch}-${digest.slice(0, 12)}.tgz`;
    const destination = join(outputDirectory, filename);
    await publishImmutableArtifact(candidate, destination);
    process.stdout.write(`${JSON.stringify({
      destination,
      sha256: digest,
      package: verification.package,
      members: verification.members,
      symlinks: verification.symlinks,
      installedPackages: verification.installedPackages,
      relocatedEntrypointLoaded: true,
      runtimeEntrypointLoaded: verification.relocation.runtimeEntrypointLoaded,
      checkedDirectDependencies: verification.relocation.checkedDirectDependencies,
    }, null, 2)}\n`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
