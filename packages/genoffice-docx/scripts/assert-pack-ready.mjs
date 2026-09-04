import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

import { assertPackEntries, sha256Sri } from '../dist/artifact-policy.js';
import { sha256Hex } from '../dist/source-policy.js';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function walk(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) throw new Error(`package symlink is forbidden: ${absolute}`);
    if (metadata.isDirectory()) files.push(...(await walk(root, absolute)));
    else if (metadata.isFile()) files.push(relative(packageRoot, absolute).replaceAll('\\', '/'));
    else throw new Error(`package contains non-regular entry: ${absolute}`);
  }
  return files;
}

const lock = JSON.parse(await readFile(join(packageRoot, 'source-lock.json'), 'utf8'));
for (const name of ['LICENSE', 'NOTICE']) {
  const actual = sha256Hex(await readFile(join(packageRoot, name)));
  if (actual !== lock.files[name]) throw new Error(`${name} does not match source lock`);
}

const rendererRoot = join(packageRoot, 'renderer');
const noticePath = join(rendererRoot, 'THIRD-PARTY-NOTICES.txt');
const sbomPath = join(rendererRoot, 'SBOM.spdx.json');
const entries = [
  'plugin.yaml',
  'source-lock.json',
  'LICENSE',
  'NOTICE',
  'THIRD_PARTY_NOTICES.md',
  ...(await walk(rendererRoot)),
].map((path) => `package/${path}`);
assertPackEntries(entries);

const notices = await readFile(noticePath, 'utf8');
if (!notices.includes(`GenOffice ${lock.tag}`) || !notices.includes('Bundled fonts')) {
  throw new Error('renderer third-party notices do not bind the frozen source and bundled fonts');
}
const sbom = JSON.parse(await readFile(sbomPath, 'utf8'));
if (sbom.spdxVersion !== 'SPDX-2.3' || !Array.isArray(sbom.files) || !Array.isArray(sbom.packages)) {
  throw new Error('renderer SBOM is not a valid SPDX 2.3 inventory');
}
const rootPackage = sbom.packages.find((entry) => entry.SPDXID === 'SPDXRef-Package-GenOffice-DOCX');
if (!/^[0-9a-f]{40}$/.test(String(rootPackage?.packageVerificationCode?.packageVerificationCodeValue))) {
  throw new Error('renderer SBOM has no package verification code');
}
const rendererPrefix = `${relative(packageRoot, rendererRoot).replaceAll('\\', '/')}/`;
const expectedFiles = (await walk(rendererRoot))
  .filter((path) => path !== `${rendererPrefix}SBOM.spdx.json`)
  .map((path) => path.slice(rendererPrefix.length))
  .sort();
const sbomFiles = new Map(
  sbom.files.map((entry) => [
    String(entry.fileName).replace(/^\.\//, ''),
    entry.checksums?.find((checksum) => checksum.algorithm === 'SHA256')?.checksumValue,
  ]),
);
if (sbomFiles.size !== expectedFiles.length) throw new Error('renderer SBOM file census is stale');
for (const path of expectedFiles) {
  const expectedDigest = sbomFiles.get(path);
  const actualDigest = sha256Hex(await readFile(join(rendererRoot, path)));
  if (expectedDigest !== actualDigest) throw new Error(`renderer SBOM digest mismatch: ${path}`);
}
if (sbom.packages.length < 2) throw new Error('renderer SBOM has no third-party dependency inventory');
if (sbom.packages.some((entry) => /electron|chromium/i.test(String(entry.name)))) {
  throw new Error('renderer SBOM contains a forbidden Electron or Chromium dependency');
}
const dependencyIds = new Set(sbom.packages.slice(1).map((entry) => entry.SPDXID));
const relatedDependencyIds = new Set(
  (Array.isArray(sbom.relationships) ? sbom.relationships : [])
    .filter(
      (entry) =>
        entry.spdxElementId === 'SPDXRef-Package-GenOffice-DOCX' && entry.relationshipType === 'DEPENDS_ON',
    )
    .map((entry) => entry.relatedSpdxElement),
);
if (dependencyIds.size !== relatedDependencyIds.size || [...dependencyIds].some((id) => !relatedDependencyIds.has(id))) {
  throw new Error('renderer SBOM dependency relationships are incomplete');
}

const manifest = parse(await readFile(join(packageRoot, 'plugin.yaml'), 'utf8'));
const declaredIntegrity = manifest.contributions?.[0]?.surface?.integrity;
const actualIntegrity = sha256Sri(await readFile(join(rendererRoot, 'index.html')));
if (declaredIntegrity !== actualIntegrity) {
  throw new Error(
    `renderer integrity mismatch: manifest=${declaredIntegrity}, actual=${actualIntegrity}`,
  );
}
process.stdout.write(`${JSON.stringify({ ready: true, integrity: actualIntegrity })}\n`);
