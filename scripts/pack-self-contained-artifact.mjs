import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assertProductionDependencyClosure } from './catalog-package-shrinkwrap.mjs';
import { normalizeBundledPublishGzip } from './canonical-publish-gzip.mjs';
import {
  assertPackageArchiveLayout,
  verifySelfContainedArchive,
} from './verify-self-contained-artifact.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const archiveTimestamp = new Date('1985-10-26T08:15:00.000Z');

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

function runBinary(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, NODE_ENV: 'development' },
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error([
      command,
      ...args,
      result.stdout?.toString('utf8'),
      result.stderr?.toString('utf8'),
    ].filter(Boolean).join('\n'));
  }
  return result.stdout;
}

function runAsync(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, NODE_ENV: 'development' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = { stderr: '', stdout: '' };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output.stdout += chunk; });
    child.stderr.on('data', (chunk) => { output.stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status, signal) => {
      if (status === 0) {
        resolvePromise(output.stdout);
        return;
      }
      reject(new Error([
        command,
        ...args,
        output.stdout,
        output.stderr,
        signal ? `terminated by ${signal}` : `exit ${status}`,
      ].filter(Boolean).join('\n')));
    });
  });
}

function artifactBase(name, version) {
  assert.match(name, /^@[a-z0-9-]+\/[a-z0-9-]+$/u);
  assert.match(version, /^[0-9A-Za-z.-]+$/u);
  return `${name.slice(1).replace('/', '-')}-${version}`;
}

async function collectArchiveMembers(root, relativePath) {
  const absolutePath = join(root, relativePath);
  const stat = await lstat(absolutePath);
  assert.ok(!stat.isSymbolicLink(), `self-contained staging has a symlink: ${relativePath}`);
  if (stat.isFile()) return [relativePath];
  assert.ok(stat.isDirectory(), `self-contained staging has a non-regular member: ${relativePath}`);
  const members = [`${relativePath}/`];
  const names = (await readdir(absolutePath)).sort((left, right) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
  for (const name of names) {
    members.push(...await collectArchiveMembers(root, join(relativePath, name)));
  }
  return members;
}

export async function createDeterministicArchive(stageRoot, destination) {
  const members = await collectArchiveMembers(stageRoot, 'package');
  for (const member of members) {
    assert.doesNotMatch(member, /[\r\n]/u, 'archive member cannot contain a line break');
  }
  // Normalize both files and directories after staging. npm tarballs normalize
  // file timestamps, but npm ci creates directories at wall-clock time; those
  // directory mtimes otherwise make an identical closure hash differently.
  for (const member of members.toReversed()) {
    await utimes(join(stageRoot, member), archiveTimestamp, archiveTimestamp);
  }
  const memberList = join(dirname(destination), `.${basename(destination)}.members`);
  const uncompressed = join(dirname(destination), `.${basename(destination)}.tar`);
  try {
    await writeFile(memberList, `${members.join('\n')}\n`);
    run('tar', [
      '--owner', '0', '--group', '0', '--no-recursion',
      '-cf', uncompressed, '-C', stageRoot, '-T', memberList,
    ], dirname(destination));
    // BSD tar's built-in gzip filter records wall-clock time in the gzip
    // header. Compress separately with -n so identical tar bytes produce an
    // identical artifact even across different runs.
    await writeFile(
      destination,
      normalizeBundledPublishGzip(
        runBinary('gzip', ['-n', '-c', uncompressed], dirname(destination)),
      ),
    );
  } finally {
    await rm(memberList, { force: true });
    await rm(uncompressed, { force: true });
  }
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

export async function installProductionDependencies({
  localPacks = new Map(),
  packageRoot,
  registry = 'https://registry.npmjs.org',
}) {
  const manifestPath = join(packageRoot, 'package.json');
  const shrinkwrapPath = join(packageRoot, 'npm-shrinkwrap.json');
  const manifestBytes = await readFile(manifestPath);
  const shrinkwrapBytes = await readFile(shrinkwrapPath);
  const installManifest = JSON.parse(manifestBytes.toString('utf8'));
  const installShrinkwrap = JSON.parse(shrinkwrapBytes.toString('utf8'));

  // npm ci validates the whole manifest against the lock even when dev
  // dependencies are omitted. Published shrinkwraps intentionally contain
  // only the production tree, so use the matching production-only root while
  // staging node_modules, then restore the canonical bytes before archiving.
  delete installManifest.devDependencies;
  delete installShrinkwrap.packages?.['']?.devDependencies;

  for (const [packageName, archive] of localPacks) {
    const packagePath = `node_modules/${packageName}`;
    const entry = installShrinkwrap.packages?.[packagePath];
    assert.ok(entry, `npm-shrinkwrap.json is missing local package ${packagePath}`);
    const archiveBytes = await readFile(archive);
    entry.resolved = pathToFileURL(archive).href;
    entry.integrity = `sha512-${createHash('sha512').update(archiveBytes).digest('base64')}`;
  }

  await writeFile(manifestPath, `${JSON.stringify(installManifest, null, 2)}\n`);
  await writeFile(shrinkwrapPath, `${JSON.stringify(installShrinkwrap, null, 2)}\n`);
  try {
    await runAsync('npm', [
      'ci', '--omit=dev', '--ignore-scripts', '--no-bin-links', '--no-audit', '--no-fund',
      '--replace-registry-host=always',
      `--registry=${registry}`,
    ], packageRoot);
  } finally {
    await writeFile(manifestPath, manifestBytes);
    await writeFile(shrinkwrapPath, shrinkwrapBytes);
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
    const stagedShrinkwrapPath = join(stagedPackage, 'npm-shrinkwrap.json');
    const stagedManifestBytes = await readFile(stagedManifestPath);
    const stagedManifest = JSON.parse(stagedManifestBytes.toString('utf8'));
    assert.equal(stagedManifest.name, sourcePackage.name, 'canonical package name differs from checkout');
    assert.equal(stagedManifest.version, sourcePackage.version, 'canonical package version differs from checkout');
    const stagedShrinkwrapBytes = await readFile(stagedShrinkwrapPath);
    const shrinkwrap = JSON.parse(stagedShrinkwrapBytes.toString('utf8'));
    assertProductionDependencyClosure(stagedManifest, shrinkwrap);

    // Dev-wave SDK and contract bytes always come from this checkout, even if
    // packages with the same versions later become available in the registry.
    const localPacks = new Map();
    if (shrinkwrap.packages['node_modules/@clowder-ai/plugin-contract']) {
      run('pnpm', ['--filter', '@clowder-ai/plugin-contract', 'build'], repoRoot);
      localPacks.set(
        '@clowder-ai/plugin-contract',
        packCheckoutPackage('plugin-contract', packRoot),
      );
    }
    if (shrinkwrap.packages['node_modules/@clowder-ai/plugin-sdk']) {
      run('pnpm', ['--filter', '@clowder-ai/plugin-sdk', 'build'], repoRoot);
      localPacks.set('@clowder-ai/plugin-sdk', packCheckoutPackage('plugin-sdk', packRoot));
    }

    await installProductionDependencies({ packageRoot: stagedPackage, localPacks });
    assert.deepEqual(
      await readFile(stagedManifestPath),
      stagedManifestBytes,
      'self-contained staging must restore the canonical package.json bytes',
    );
    assert.deepEqual(
      await readFile(stagedShrinkwrapPath),
      stagedShrinkwrapBytes,
      'self-contained staging must restore the canonical npm-shrinkwrap.json bytes',
    );

    await rm(join(stagedPackage, 'node_modules/.package-lock.json'), { force: true });
    const candidate = join(temporaryRoot, 'candidate.tgz');
    await createDeterministicArchive(stageRoot, candidate);
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
