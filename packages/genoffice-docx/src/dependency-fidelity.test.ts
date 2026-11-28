/**
 * Guard: the XLSX extractor's test dependencies stay on the versions the frozen
 * GenOffice source tree actually ships.
 *
 * `preview/spreadsheet-extract.ts` is a copy of the upstream extractor, and
 * `preview/xlsx-extraction.test.ts` exercises it with `jszip` and
 * `fast-xml-parser`. Those two are devDependencies of this package now, so
 * `pnpm` may resolve them independently of the frozen tree. If the versions
 * drift the test still passes — but it is then testing a parser the production
 * preview never runs, which silently turns "verified" into a guess.
 *
 * The expected versions are read from `source-lock.json`'s tree rather than
 * hardcoded, so bumping the locked source updates the expectation with it.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = join(import.meta.dirname, '..');

interface LockedSource {
  readonly rootDirectory: string;
}

const lock = JSON.parse(
  await readFile(join(packageRoot, 'source-lock.json'), 'utf8'),
) as LockedSource;

/** Version of one dependency as the frozen GenOffice tree pins it. */
async function frozenVersion(name: string): Promise<string> {
  const path = join(
    packageRoot,
    '.tmp',
    'source',
    lock.rootDirectory,
    'node_modules',
    name,
    'package.json',
  );
  const manifest = JSON.parse(await readFile(path, 'utf8')) as { version?: string };
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`frozen ${name} has no version`);
  }
  return manifest.version;
}

/** Version this package actually resolves for the extractor tests. */
async function resolvedVersion(name: string): Promise<string> {
  // Not `require('<name>/package.json')`: packages are free to omit that subpath
  // from `exports` (fast-xml-parser does), which makes the require fail for a
  // reason unrelated to the version. Resolve the package entry, then read the
  // manifest beside it.
  const entry = fileURLToPath(import.meta.resolve(name, new URL('../package.json', import.meta.url)));
  let dir = dirname(entry);
  for (;;) {
    const candidate = join(dir, 'package.json');
    const manifest = JSON.parse(await readFile(candidate, 'utf8').catch(() => 'null')) as
      | { name?: string; version?: string }
      | null;
    if (manifest?.name === name) {
      if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
        throw new Error(`resolved ${name} has no version`);
      }
      return manifest.version;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`cannot locate package.json for ${name}`);
    dir = parent;
  }
}

for (const name of ['jszip', 'fast-xml-parser'] as const) {
  test(`the extractor test dependency ${name} matches the frozen source tree`, async () => {
    // Skip instead of fail when the frozen tree is not extracted on this host
    // (renderer builds fetch it on demand). A missing tree cannot answer the
    // question, so asserting either way would be a lie; CI extracts it.
    const expected = await frozenVersion(name).catch(() => null);
    if (expected === null) {
      test.skip?.(`frozen source tree not present; cannot compare ${name}`);
      return;
    }
    assert.equal(
      await resolvedVersion(name),
      expected,
      `${name} resolved to ${await resolvedVersion(name)} but the frozen GenOffice tree pins ` +
        `${expected}; the extractor test would exercise a different parser than production. ` +
        `Pin it in devDependencies or refresh source-lock.json.`,
    );
  });
}
