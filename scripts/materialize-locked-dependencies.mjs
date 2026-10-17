import assert from 'node:assert/strict';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';

const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu;
const exactVersion = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/u;

function contained(root, path) {
  const suffix = relative(root, path);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`));
}

async function resolveInstalled(root, name, repoRoot) {
  assert.match(name, packageName, 'unsupported locked package name');
  for (let cursor = root; contained(repoRoot, cursor); cursor = dirname(cursor)) {
    if (cursor.endsWith(`${sep}node_modules`)) continue;
    const candidate = join(cursor, 'node_modules', name);
    try { await lstat(candidate); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const target = await realpath(candidate);
    assert.ok(contained(repoRoot, target), `locked dependency escapes checkout: ${name}`);
    return target;
  }
  throw new Error(`missing locked dependency ${name} from ${root}`);
}

// Read the wanted lock and the *installed* paths. No resolver, package manager
// install, registry metadata or version-range selection runs during packaging.
// The destination must already contain the root package's publishable files.
export async function materializeLockedDependencies({
  repoRoot, packageRoot, destination, copyPublishPackage,
}) {
  assert.equal(typeof copyPublishPackage, 'function', 'publish-file copier is required');
  repoRoot = await realpath(repoRoot);
  packageRoot = await realpath(packageRoot);
  assert.ok(contained(repoRoot, packageRoot), 'bundle source escapes checkout');
  const lock = parse(await readFile(join(repoRoot, 'pnpm-lock.yaml'), 'utf8'));
  const nodes = new Map();
  const pending = [];

  async function nodeAt(root, selector, expectedName, expectedVersion) {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    assert.equal(manifest.name, expectedName, `locked identity mismatch at ${root}`);
    assert.equal(manifest.version, expectedVersion, `locked identity mismatch at ${root}`);
    if (nodes.has(root)) {
      assert.equal(nodes.get(root).selector, selector, `locked peer context mismatch at ${root}`);
      return nodes.get(root);
    }
    const workspace = selector.startsWith('importer:');
    const snapshot = workspace ? lock.importers?.[selector.slice(9)] : lock.snapshots?.[selector];
    assert.ok(snapshot, `missing locked snapshot ${selector}`);
    if (workspace) {
      for (const field of ['dependencies', 'optionalDependencies']) {
        assert.deepEqual(Object.fromEntries(Object.entries(snapshot[field] ?? {}).map(([name, edge]) =>
          [name, edge.specifier])), manifest[field] ?? {}, `stale locked ${field} at ${root}`);
      }
    } else {
      for (const name of Object.keys(manifest.dependencies ?? {})) {
        assert.ok(snapshot.dependencies?.[name] || snapshot.optionalDependencies?.[name],
          `missing locked production edge ${name} at ${root}`);
      }
    }
    const node = { root, selector, manifest, workspace, snapshot, edges: new Map() };
    nodes.set(root, node);
    pending.push(node);
    return node;
  }

  const rootManifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const importer = relative(repoRoot, packageRoot).split(sep).join('/') || '.';
  const rootNode = await nodeAt(packageRoot, `importer:${importer}`, rootManifest.name, rootManifest.version);
  for (let index = 0; index < pending.length; index++) {
    const node = pending[index];
    for (const field of ['dependencies', 'optionalDependencies']) {
      for (const [name, edge] of Object.entries(node.snapshot[field] ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
        const ref = node.workspace ? edge.version : edge;
        let target;
        try { target = await resolveInstalled(node.root, name, repoRoot); } catch (error) {
          if (field === 'optionalDependencies' && error.message.startsWith('missing locked dependency ')) continue;
          throw error;
        }
        let child;
        if (ref.startsWith('link:')) {
          assert.ok(node.workspace, 'registry package has a workspace link');
          const expectedRoot = await realpath(resolve(node.root, ref.slice(5)));
          assert.equal(target, expectedRoot, `locked workspace target mismatch for ${name}`);
          const linkedManifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
          child = await nodeAt(target, `importer:${relative(repoRoot, target).split(sep).join('/')}`,
            name, linkedManifest.version);
          if (exactVersion.test(edge.specifier))
            assert.equal(linkedManifest.version, edge.specifier, `locked identity mismatch for ${name}`);
        } else {
          const version = ref.split('(')[0];
          assert.match(version, exactVersion, `unsupported locked dependency ${name}@${ref}`);
          child = await nodeAt(target, `${name}@${ref}`, name, version);
        }
        node.edges.set(name, child);
      }
    }
  }

  const placements = new Map([[resolve(destination), rootNode]]);
  const work = [];
  function place(path, node) {
    assert.ok(!placements.has(path), `duplicate bundle placement ${path}`);
    placements.set(path, node);
    work.push({ path, node });
  }
  // Reserve all direct identities before hoisting indirect nodes. Conflicting
  // versions/peer contexts get a physical nested package, never a symlink.
  const hoisted = new Set();
  for (const node of pending.slice(1)) {
    if (hoisted.has(node.manifest.name)) continue;
    hoisted.add(node.manifest.name);
    place(join(destination, 'node_modules', node.manifest.name), node);
  }
  function resolvedPlacement(path, name) {
    for (let cursor = path; contained(resolve(destination), cursor); cursor = dirname(cursor)) {
      if (cursor.endsWith(`${sep}node_modules`)) continue;
      const candidate = placements.get(join(cursor, 'node_modules', name));
      if (candidate) return candidate;
    }
    return undefined;
  }
  for (const [name, child] of rootNode.edges) {
    if (resolvedPlacement(resolve(destination), name) !== child)
      place(join(destination, 'node_modules', name), child);
  }
  for (let index = 0; index < work.length; index++) {
    const { path, node } = work[index];
    for (const [name, child] of node.edges) {
      if (resolvedPlacement(path, name) !== child) place(join(path, 'node_modules', name), child);
    }
  }
  // Resolve the complete graph before writing, so missing/drifting identities
  // cannot leave a seemingly usable partial staging tree.
  for (const { path, node } of work) {
    await copyPublishPackage(node.root, path);
  }
  return { packages: nodes.size - 1, placements: work.length };
}
