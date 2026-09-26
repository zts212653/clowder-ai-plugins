import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

export const OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org';
export const PUBLISH_ACTION = './.github/actions/publish-prerelease';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    const error = new Error(
      [command, ...args, result.stdout, result.stderr].filter(Boolean).join('\n'),
    );
    error.status = result.status;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  return result.stdout;
}

export function collectCatalogNpmClaims(catalog) {
  const claims = [];
  for (const plugin of catalog.plugins ?? []) {
    for (const version of plugin.versions ?? []) {
      const artifact = version.artifact;
      if (artifact?.kind !== 'npm') continue;
      for (const field of ['packageName', 'version', 'integrity']) {
        if (typeof artifact[field] !== 'string' || artifact[field].length === 0) {
          throw new Error(`${plugin.pluginId} catalog npm artifact is missing ${field}`);
        }
      }
      claims.push({
        name: artifact.packageName,
        version: artifact.version,
        integrity: artifact.integrity,
        source: `catalog ${plugin.pluginId}@${version.version}`,
      });
    }
  }
  return claims;
}

export function collectPublishPackageDirectories(workflowSource) {
  const workflow = parse(workflowSource);
  const directories = [];
  for (const job of Object.values(workflow?.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      if (step?.uses !== PUBLISH_ACTION) continue;
      const directory = step.with?.['package-directory'];
      if (typeof directory !== 'string' || !/^packages\/[a-z0-9-]+$/u.test(directory)) {
        throw new Error(`publish-prerelease step has invalid package-directory: ${directory}`);
      }
      directories.push(directory);
    }
  }
  const unique = [...new Set(directories)].sort();
  if (unique.length === 0) {
    throw new Error('Contract CI has no publish-prerelease package directories');
  }
  if (unique.length !== directories.length) {
    throw new Error('Contract CI publishes the same package directory more than once');
  }
  return unique;
}

export function addImmutableClaim(claims, claim) {
  const identity = `${claim.name}@${claim.version}`;
  const existing = claims.get(identity);
  if (existing !== undefined && existing.integrity !== claim.integrity) {
    throw new Error(
      `${identity} has conflicting local bytes: ${existing.integrity} (${existing.sources.join(', ')}) != ${claim.integrity} (${claim.source})`,
    );
  }
  if (existing === undefined) {
    claims.set(identity, { ...claim, sources: [claim.source] });
  } else {
    existing.sources.push(claim.source);
  }
}

export async function readRegistryIntegrity(name, version, { fetchFn = globalThis.fetch } = {}) {
  const url = new URL(
    `${OFFICIAL_NPM_REGISTRY}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
  );
  let response;
  try {
    response = await fetchFn(url, { headers: { accept: 'application/json' } });
  } catch (error) {
    throw new Error(`npm registry lookup failed for ${name}@${version}`, { cause: error });
  }
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(
      `npm registry lookup failed for ${name}@${version}: HTTP ${response.status}`,
    );
  }
  const metadata = await response.json();
  const integrity = metadata?.dist?.integrity;
  if (typeof integrity !== 'string' || integrity.length === 0) {
    throw new Error(`registry returned no dist.integrity for ${name}@${version}`);
  }
  return integrity;
}

export async function assertRegistryCompatibility({
  catalog,
  workflowSource,
  root = repoRoot,
  registryIntegrity = readRegistryIntegrity,
  packCurrentPackage,
} = {}) {
  const claims = new Map();
  for (const claim of collectCatalogNpmClaims(catalog)) addImmutableClaim(claims, claim);

  const checked = new Set();
  const published = [];
  const unpublished = [];
  async function check(claim) {
    const identity = `${claim.name}@${claim.version}`;
    if (checked.has(identity)) return;
    const actual = await registryIntegrity(claim.name, claim.version);
    if (actual === undefined) {
      unpublished.push(identity);
    } else if (actual !== claim.integrity) {
      throw new Error(
        `${identity} is already published with immutable integrity ${actual}, but ${claim.sources.join(', ')} claims ${claim.integrity}`,
      );
    } else {
      published.push(identity);
    }
    checked.add(identity);
  }

  // Check catalog history first. A stale pin should fail without spending time
  // packing every current package.
  for (const claim of claims.values()) await check(claim);

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'clowder-registry-compat-'));
  try {
    for (const directory of collectPublishPackageDirectories(workflowSource)) {
      let artifact;
      if (packCurrentPackage !== undefined) {
        artifact = await packCurrentPackage(directory, temporaryRoot);
      } else {
        const output = run(
          process.execPath,
          ['scripts/pack-publish-artifact.mjs', directory, temporaryRoot],
          { cwd: root },
        );
        [artifact] = JSON.parse(output);
      }
      for (const field of ['name', 'version', 'integrity']) {
        if (typeof artifact?.[field] !== 'string' || artifact[field].length === 0) {
          throw new Error(`${directory} pack result is missing ${field}`);
        }
      }
      addImmutableClaim(claims, {
        name: artifact.name,
        version: artifact.version,
        integrity: artifact.integrity,
        source: `publish job ${directory}`,
      });
      await check(claims.get(`${artifact.name}@${artifact.version}`));
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  return {
    claims: claims.size,
    published: published.sort(),
    unpublished: unpublished.sort(),
  };
}

async function main() {
  const catalog = JSON.parse(await readFile(join(repoRoot, 'catalog/catalog.json'), 'utf8'));
  const workflowSource = await readFile(
    join(repoRoot, '.github/workflows/contract-ci.yml'),
    'utf8',
  );
  const result = await assertRegistryCompatibility({ catalog, workflowSource });
  process.stdout.write(
    `registry compatibility: ${result.claims} immutable identities; ${result.published.length} published match npmjs.org; ${result.unpublished.length} remain eligible\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
