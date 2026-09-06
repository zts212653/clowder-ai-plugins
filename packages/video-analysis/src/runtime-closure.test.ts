import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

interface PackageLockEntry {
  readonly integrity?: unknown;
  readonly link?: unknown;
  readonly resolved?: unknown;
  readonly version?: unknown;
}

interface RuntimePackageJson {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

interface RuntimeShrinkwrap {
  readonly lockfileVersion?: unknown;
  readonly packages?: Readonly<Record<string, PackageLockEntry>>;
}

function isCanonicalSha512(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('sha512-')) return false;
  const encoded = value.slice('sha512-'.length);
  const decoded = Buffer.from(encoded, 'base64');
  return decoded.byteLength === 64 && decoded.toString('base64') === encoded;
}

test('ships one registry-bounded publisher lock for the runtime dependency closure', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as RuntimePackageJson;
  const shrinkwrap = JSON.parse(
    await readFile(new URL('../npm-shrinkwrap.json', import.meta.url), 'utf8'),
  ) as RuntimeShrinkwrap;

  assert.ok(shrinkwrap.lockfileVersion === 2 || shrinkwrap.lockfileVersion === 3);
  assert.ok(shrinkwrap.packages);
  const root = shrinkwrap.packages[''] as RuntimePackageJson | undefined;
  assert.ok(root);
  assert.deepEqual(root.dependencies ?? {}, packageJson.dependencies ?? {});
  assert.deepEqual(
    root.optionalDependencies ?? {},
    packageJson.optionalDependencies ?? {},
  );

  for (const [path, entry] of Object.entries(shrinkwrap.packages)) {
    if (path.length === 0) continue;
    assert.match(path, /^node_modules\//u);
    assert.notEqual(entry.link, true);
    assert.match(
      String(entry.version),
      /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
    );
    assert.match(
      String(entry.resolved),
      /^https:\/\/registry\.npmjs\.org\//u,
    );
    assert.equal(isCanonicalSha512(entry.integrity), true);
  }
});
