import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const identityPath = new URL('./attested-artifact-identities.json', import.meta.url);

function run(command, args, cwd = repoRoot) {
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

export function validateAttestedArtifactRegistry(value) {
  assert.equal(value?.schemaVersion, 1, 'attested artifact registry schemaVersion must be 1');
  assert.ok(Array.isArray(value.artifacts), 'attested artifact registry must contain artifacts');
  const identities = new Set();
  const directories = new Map();
  for (const artifact of value.artifacts) {
    assert.deepEqual(
      Object.keys(artifact).sort(),
      ['package', 'packageDirectory', 'sha256', 'size', 'source', 'version'],
      'attested artifact entry has an unsupported field',
    );
    assert.match(artifact.package, /^@clowder-ai\/[a-z0-9-]+$/u);
    assert.match(artifact.packageDirectory, /^packages\/[a-z0-9-]+$/u);
    assert.match(artifact.version, /^\d+\.\d+\.\d+-[a-z]+\.\d+$/u);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/u);
    assert.ok(Number.isSafeInteger(artifact.size) && artifact.size > 0);
    assert.ok(typeof artifact.source === 'string' && artifact.source.length > 0);
    const identity = `${artifact.package}@${artifact.version}`;
    assert.ok(!identities.has(identity), `duplicate attested artifact identity: ${identity}`);
    identities.add(identity);
    const existingDirectory = directories.get(artifact.package);
    assert.ok(
      existingDirectory === undefined || existingDirectory === artifact.packageDirectory,
      `${artifact.package} has inconsistent package directories`,
    );
    directories.set(artifact.package, artifact.packageDirectory);
  }
  return value.artifacts;
}

export function assertAttestedArtifactIdentity(artifact, attestations) {
  const attested = attestations.find(
    candidate => candidate.package === artifact.name && candidate.version === artifact.version,
  );
  if (attested === undefined) return { status: 'unattested', artifact };
  if (artifact.sha256 !== attested.sha256 || artifact.size !== attested.size) {
    throw new Error(
      `${artifact.name} version ${artifact.version} was attested as ${attested.sha256} ` +
        `(${attested.size} bytes); bump the version`,
    );
  }
  return { status: 'matched', artifact, attested };
}

async function packPackage(packageDirectory, destination) {
  const output = run(
    process.execPath,
    ['scripts/pack-publish-artifact.mjs', packageDirectory, destination],
  );
  const parsed = JSON.parse(output);
  assert.equal(parsed.length, 1, `${packageDirectory} pack must produce exactly one artifact`);
  const artifact = parsed[0];
  const bytes = await readFile(join(destination, artifact.filename));
  return {
    name: artifact.name,
    version: artifact.version,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength,
  };
}

export async function verifyAttestedArtifactIdentities({
  registry,
  pack = packPackage,
} = {}) {
  const attestations = validateAttestedArtifactRegistry(registry);
  const packageDirectories = [...new Set(attestations.map(entry => entry.packageDirectory))].sort();
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'clowder-attested-artifacts-'));
  const results = [];
  try {
    for (const packageDirectory of packageDirectories) {
      const artifact = await pack(packageDirectory, temporaryRoot);
      const expectedPackage = attestations.find(
        entry => entry.packageDirectory === packageDirectory,
      )?.package;
      assert.equal(artifact.name, expectedPackage, `${packageDirectory} packed the wrong package`);
      results.push(assertAttestedArtifactIdentity(artifact, attestations));
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  return results;
}

async function main() {
  const registry = JSON.parse(await readFile(identityPath, 'utf8'));
  const results = await verifyAttestedArtifactIdentities({ registry });
  for (const result of results) {
    const identity = `${result.artifact.name}@${result.artifact.version}`;
    process.stdout.write(
      result.status === 'matched'
        ? `attested artifact matches: ${identity}\n`
        : `current artifact is not yet attested: ${identity}\n`,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
