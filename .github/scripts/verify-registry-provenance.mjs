import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const [name, version, integrity, attestationUrl, outputDirectory] = process.argv.slice(2);

assert.match(name ?? '', /^@clowder-ai\/[a-z0-9-]+$/u);
assert.match(version ?? '', /^\d+\.\d+\.\d+-alpha\.\d+$/u);
assert.match(integrity ?? '', /^sha512-[A-Za-z0-9+/]+={0,2}$/u);
assert.match(
  attestationUrl ?? '',
  /^https:\/\/registry\.npmjs\.org\/-\/npm\/v1\/attestations\//u,
);
assert(outputDirectory, 'output directory is required');

const output = resolve(outputDirectory);
await mkdir(output, { recursive: true });

const response = await fetch(attestationUrl);
assert.equal(response.status, 200, `registry attestation HTTP ${response.status}`);
const registryAttestation = await response.json();
await writeFile(
  join(output, 'registry-attestations.json'),
  JSON.stringify(registryAttestation, null, 2) + '\n',
);

assert(Array.isArray(registryAttestation.attestations));
const provenanceEntries = registryAttestation.attestations.filter(
  (entry) => entry.predicateType === 'https://slsa.dev/provenance/v1',
);
assert.equal(provenanceEntries.length, 1, 'expected one SLSA v1 provenance entry');
const provenanceBundle = provenanceEntries[0].bundle;
assert(provenanceBundle?.dsseEnvelope?.payload, 'provenance entry has no DSSE payload');

const bundlePath = join(output, 'provenance.sigstore.json');
await writeFile(bundlePath, JSON.stringify(provenanceBundle));

const npmRoot = execFileSync('npm', ['root', '--global'], { encoding: 'utf8' }).trim();
const require = createRequire(import.meta.url);
const { verifyProvenance } = require(
  join(npmRoot, 'npm/node_modules/libnpmpublish/lib/provenance.js'),
);
const subject = {
  name: `pkg:npm/${name.replace('@', '%40')}@${version}`,
  digest: {
    sha512: Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex'),
  },
};
await verifyProvenance(subject, bundlePath);

const payload = JSON.parse(
  Buffer.from(provenanceBundle.dsseEnvelope.payload, 'base64').toString('utf8'),
);
assert.equal(payload.predicateType, 'https://slsa.dev/provenance/v1');
const definition = payload.predicate?.buildDefinition;
const workflow = definition?.externalParameters?.workflow;
const sources = definition?.resolvedDependencies;
const invocation = payload.predicate?.runDetails?.metadata?.invocationId;

assert.deepEqual(Object.keys(workflow ?? {}).sort(), ['path', 'ref', 'repository']);
assert.equal(workflow.repository, 'https://github.com/zts212653/clowder-ai-plugins');
assert.equal(workflow.path, '.github/workflows/contract-ci.yml');
assert.match(workflow.ref, /^refs\/heads\/[A-Za-z0-9._/-]+$/u);
assert.equal(sources?.length, 1);
assert.equal(sources[0].uri, `git+${workflow.repository}@${workflow.ref}`);
assert.match(sources[0].digest?.gitCommit ?? '', /^[a-f0-9]{40}$/u);
assert.match(
  invocation ?? '',
  /^https:\/\/github\.com\/zts212653\/clowder-ai-plugins\/actions\/runs\/\d+\/attempts\/\d+$/u,
);

if (process.env.EXPECTED_PROVENANCE_REF) {
  assert.equal(workflow.ref, process.env.EXPECTED_PROVENANCE_REF);
}
if (process.env.EXPECTED_PROVENANCE_COMMIT) {
  assert.equal(sources[0].digest.gitCommit, process.env.EXPECTED_PROVENANCE_COMMIT);
}
if (process.env.EXPECTED_PROVENANCE_RUN) {
  assert.equal(invocation, process.env.EXPECTED_PROVENANCE_RUN);
}

const verification = {
  package: name,
  version,
  integrity,
  attestationUrl,
  predicateType: payload.predicateType,
  source: sources,
  workflow,
  run: invocation,
  provenanceVerified: true,
};
await writeFile(
  join(output, 'provenance-verification.json'),
  JSON.stringify(verification, null, 2) + '\n',
);
process.stdout.write(`${JSON.stringify(verification)}\n`);

