import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const [packageDirectory, packJsonPath, evidencePath, expectedHeadSha] = process.argv.slice(2);

if (!/^packages\/[a-z0-9-]+$/u.test(packageDirectory ?? '')) {
  throw new Error('package directory must be a repository-relative packages/<name> path');
}
for (const [label, value] of [
  ['pack JSON path', packJsonPath],
  ['evidence path', evidencePath],
  ['expected HEAD SHA', expectedHeadSha],
]) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is required`);
}

const actualHeadSha = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).trim();
if (actualHeadSha !== expectedHeadSha) {
  throw new Error(`checkout HEAD mismatch: ${actualHeadSha} != ${expectedHeadSha}`);
}
const trackedChanges = execFileSync(
  'git',
  ['status', '--porcelain', '--untracked-files=no'],
  { cwd: repoRoot, encoding: 'utf8' },
).trim();
if (trackedChanges.length > 0) {
  throw new Error(`tracked files changed before pack evidence capture:\n${trackedChanges}`);
}

mkdirSync(dirname(resolve(packJsonPath)), { recursive: true });
const packJson = execFileSync(
  'npm',
  [
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    dirname(resolve(packJsonPath)),
  ],
  {
    cwd: resolve(repoRoot, packageDirectory),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  },
);
writeFileSync(packJsonPath, packJson);

const [artifact] = JSON.parse(packJson);
for (const field of ['name', 'version', 'filename', 'integrity', 'shasum']) {
  if (typeof artifact?.[field] !== 'string' || artifact[field].length === 0) {
    throw new Error(`npm pack did not report ${field}`);
  }
}
for (const field of ['size', 'unpackedSize']) {
  if (!Number.isFinite(artifact?.[field]) || artifact[field] <= 0) {
    throw new Error(`npm pack did not report ${field}`);
  }
}
if (!Array.isArray(artifact?.files) || artifact.files.length === 0) {
  throw new Error('npm pack did not report files');
}

const evidence = {
  headSha: actualHeadSha,
  name: artifact.name,
  version: artifact.version,
  filename: basename(artifact.filename),
  integrity: artifact.integrity,
  shasum: artifact.shasum,
  size: artifact.size,
  unpackedSize: artifact.unpackedSize,
  entryCount: artifact.files.length,
  toolchain: {
    node: process.version,
    npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
    zlib: process.versions.zlib,
  },
};
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Exact-head pack evidence: ${artifact.name}\n\n\`\`\`json\n${JSON.stringify(evidence, null, 2)}\n\`\`\`\n`,
  );
}
