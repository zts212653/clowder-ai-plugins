import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function verifyArchive(target, packed, bytes) {
  assert.equal(packed.name, target.name);
  assert.equal(packed.version, target.version);
  assert.match(packed.filename, /^[a-z0-9.-]+\.tgz$/);
  assert.equal(bytes.length, target.size);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), target.sha256);
  assert.equal(createHash('sha1').update(bytes).digest('hex'), target.shasum);
  assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, target.integrity);
  return {
    name: `pkg:npm/${target.name.replace('@', '%40')}@${target.version}`,
    digest: { sha512: createHash('sha512').update(bytes).digest('hex') },
  };
}

export function verifyTargets(manifest) {
  assert.equal(manifest.sourceCommit, '29595a7794486ed0e6354a35a706875998e23d8f');
  assert.equal(manifest.tag, 'next');
  assert.equal(manifest.targets.length, 19);
  assert.equal(new Set(manifest.targets.map(t => t.name)).size, 19);
  for (const target of manifest.targets) {
    assert.match(target.directory, /^[a-z0-9-]+$/);
    assert.equal(target.name, `@clowder-ai/${target.directory}`);
    assert.match(target.version, /^\d+\.\d+\.\d+-(alpha|beta)\.\d+$/);
    assert.match(target.sha256, /^[a-f0-9]{64}$/);
    assert(Number.isSafeInteger(target.size) && target.size > 0);
  }
}

async function main(outputDirectory) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.GITHUB_REPOSITORY, 'zts212653/clowder-ai-plugins');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.equal(process.env.GITHUB_HEAD_REF, 'diag/f202-provenance-recovery');
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), process.env.GITHUB_SHA);
  assert(!process.env.NPM_TOKEN && !process.env.NODE_AUTH_TOKEN);
  assert.equal(execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(), '11.16.0');
  const require = createRequire(import.meta.url);
  const npmRoot = execFileSync('npm', ['root', '--global'], { encoding: 'utf8' }).trim();
  const { generateProvenance, verifyProvenance } = require(join(npmRoot, 'npm/node_modules/libnpmpublish/lib/provenance.js'));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = JSON.parse(await readFile(join(root, 'scripts/f202-publish-recovery-targets.json'), 'utf8'));
  verifyTargets(manifest);
  const out = resolve(outputDirectory);
  await mkdir(out, { recursive: true });
  const rows = [];
  // Verify every rebuilt archive before requesting even one signing identity.
  for (const target of manifest.targets) {
    const [packed] = JSON.parse(execFileSync(process.execPath, ['scripts/pack-publish-artifact.mjs', `packages/${target.directory}`, out], { cwd: root, encoding: 'utf8' }));
    assert.match(packed.filename, /^[a-z0-9.-]+\.tgz$/);
    const bytes = await readFile(join(out, packed.filename));
    rows.push({ ...target, filename: packed.filename, subject: verifyArchive(target, packed, bytes) });
  }
  for (const row of rows) {
    const bundle = await generateProvenance([row.subject], {});
    const provenanceFile = `${row.filename}.sigstore.json`;
    await writeFile(join(out, provenanceFile), JSON.stringify(bundle));
    await verifyProvenance(row.subject, join(out, provenanceFile));
    row.provenanceFile = provenanceFile;
    console.log(JSON.stringify({ name: row.name, version: row.version, sha256: row.sha256, signedAndVerified: true }));
  }
  await writeFile(join(out, 'manifest.json'), JSON.stringify({ sourceCommit: manifest.sourceCommit, builtCommit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, tag: 'next', targets: rows }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert(process.argv[2], 'output directory required');
  await main(process.argv[2]);
}
