import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { assertProductionDependencyClosure } from './catalog-package-shrinkwrap.mjs';

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error([command, ...args, result.stdout, result.stderr].filter(Boolean).join('\n'));
  }
  return result.stdout;
}

function contained(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

// Match the Host package-staging member rule before tar is allowed to extract.
export function assertPackageArchiveLayout(archivePath) {
  const members = run('tar', ['-tzf', archivePath], process.cwd()).trimEnd().split('\n');
  assert.ok(members.length > 0 && members[0] !== '', 'self-contained archive is empty');
  for (const member of members) {
    const normalized = posix.normalize(member);
    assert.ok(
      !member.includes('\\') &&
      !/[\u0000-\u001f]/u.test(member) &&
      !posix.isAbsolute(member) &&
      normalized !== '.' &&
      normalized !== '..' &&
      !normalized.startsWith('../') &&
      normalized.startsWith('package/'),
      `archive member is outside canonical package/ tree: ${member}`,
    );
  }
  const types = run('tar', ['-tvzf', archivePath], process.cwd()).trimEnd().split('\n');
  assert.equal(types.length, members.length, 'archive listing counts disagree');
  for (const entry of types) {
    assert.match(entry, /^[-d]/u, 'archive contains a link or non-regular member');
  }
  return members.length;
}

async function assertPhysicalTree(root) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const stat = await lstat(path);
      assert.ok(!stat.isSymbolicLink(), `self-contained archive has a symlink: ${path}`);
      if (stat.isDirectory()) pending.push(path);
      else assert.ok(stat.isFile(), `self-contained archive has a non-regular member: ${path}`);
    }
  }
}

async function assertInstalledVersions(packageRoot, shrinkwrap) {
  const packages = shrinkwrap.packages ?? {};
  const physicalRoot = await realpath(packageRoot);
  const pending = [join(packageRoot, 'node_modules')];
  let count = 0;

  while (pending.length > 0) {
    const modules = pending.pop();
    const entries = await readdir(modules, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const parent = join(modules, entry.name);
      const packageDirectories = entry.name.startsWith('@')
        ? (await readdir(parent)).map(name => join(parent, name))
        : [parent];
      for (const directory of packageDirectories) {
        const path = relative(packageRoot, directory).split(sep).join('/');
        assert.ok(contained(physicalRoot, await realpath(directory)), `installed package escaped extracted root: ${path}`);
        const locked = packages[path];
        assert.ok(locked, `installed production package is absent from shrinkwrap: ${path}`);
        const installed = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
        const normalizedInstalledVersion = installed.version.trim().replace(/^[=v]+/u, '');
        assert.equal(
          normalizedInstalledVersion,
          locked.version,
          `${path} version differs from shrinkwrap (installed: ${JSON.stringify(installed.version)}, shrinkwrap: ${JSON.stringify(locked.version)})`,
        );
        count += 1;
        const nested = join(directory, 'node_modules');
        try {
          const stat = await lstat(nested);
          if (stat.isDirectory()) pending.push(nested);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
    }
  }
  return count;
}

export async function verifySelfContainedArchive(archivePath) {
  const absoluteArchive = resolve(archivePath);
  const members = assertPackageArchiveLayout(absoluteArchive);
  const extractionRoot = await mkdtemp(join(tmpdir(), 'clowder-self-contained-verify-'));
  try {
    run('tar', ['-xzf', absoluteArchive, '-C', extractionRoot], extractionRoot);
    const packageRoot = join(extractionRoot, 'package');
    await assertPhysicalTree(packageRoot);
    try {
      await lstat(join(packageRoot, 'node_modules/.package-lock.json'));
      throw new Error('self-contained archive contains npm temporary install metadata');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const pluginManifest = parseYaml(await readFile(join(packageRoot, 'plugin.yaml'), 'utf8'));
    const shrinkwrap = JSON.parse(await readFile(join(packageRoot, 'npm-shrinkwrap.json'), 'utf8'));
    assertProductionDependencyClosure(manifest, shrinkwrap);
    const installedPackages = await assertInstalledVersions(packageRoot, shrinkwrap);
    run('npm', ['ls', '--omit=dev', '--all', '--depth=100'], packageRoot);

    const mainEntrypoint = manifest.main ?? manifest.exports?.['.']?.import;
    const runtimeEntrypoint = pluginManifest?.runtime?.entrypoint;
    if (runtimeEntrypoint !== undefined && pluginManifest.runtime.transport !== 'builtin') {
      throw new Error(`runtime transport ${pluginManifest.runtime.transport} needs a transport-specific relocation probe`);
    }
    assert.equal(typeof mainEntrypoint, 'string', 'package must declare a loadable main entrypoint');
    if (runtimeEntrypoint !== undefined) {
      assert.equal(typeof runtimeEntrypoint, 'string', 'builtin runtime must declare a string entrypoint');
    }
    const evaluation = `
      import { readFileSync, realpathSync } from 'node:fs';
      import { resolve, relative, sep, isAbsolute } from 'node:path';
      import { fileURLToPath, pathToFileURL } from 'node:url';
      const root = realpathSync('.');
      const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
      const inside = path => { const r = relative(root, path); return r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r); };
      const load = async declared => {
        const entry = realpathSync(resolve(root, declared));
        if (!inside(entry)) throw new Error('entrypoint escaped extracted package');
        return { entry, namespace: await import(pathToFileURL(entry).href) };
      };
      const main = await load(${JSON.stringify(mainEntrypoint)});
      const runtimeDeclaration = ${JSON.stringify(runtimeEntrypoint ?? null)};
      const runtime = runtimeDeclaration === null ? null : await load(runtimeDeclaration);
      if (runtime !== null) {
        const candidate = runtime.namespace.default;
        if ((candidate === null || (typeof candidate !== 'object' && typeof candidate !== 'function'))
          || typeof candidate.create !== 'function') {
          throw new TypeError('builtin runtime entrypoint default export must satisfy PluginModuleEntrypoint');
        }
      }
      for (const name of Object.keys(manifest.dependencies ?? {})) {
        const resolved = realpathSync(fileURLToPath(import.meta.resolve(name)));
        if (!inside(resolved)) throw new Error(name + ' resolved outside extracted package: ' + resolved);
      }
      console.log(JSON.stringify({
        entry: main.entry,
        runtimeEntry: runtime?.entry ?? null,
        runtimeEntrypointLoaded: runtime !== null,
        checkedDirectDependencies: Object.keys(manifest.dependencies ?? {}).length,
      }));
    `;
    const relocation = JSON.parse(run(
      process.execPath,
      ['--input-type=module', '--eval', evaluation],
      packageRoot,
    ).trim());
    assert.ok(contained(await realpath(packageRoot), relocation.entry));
    if (relocation.runtimeEntry !== null) {
      assert.ok(contained(await realpath(packageRoot), relocation.runtimeEntry));
    }
    return {
      archive: absoluteArchive,
      package: `${manifest.name}@${manifest.version}`,
      members,
      symlinks: 0,
      installedPackages,
      relocation,
    };
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const archive = process.argv[2];
  if (!archive) throw new Error('usage: node scripts/verify-self-contained-artifact.mjs <archive.tgz>');
  process.stdout.write(`${JSON.stringify(await verifySelfContainedArchive(archive), null, 2)}\n`);
}
