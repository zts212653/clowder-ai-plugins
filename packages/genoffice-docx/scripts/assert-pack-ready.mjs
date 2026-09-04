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
const entries = [
  'plugin.yaml',
  'source-lock.json',
  'LICENSE',
  'NOTICE',
  'THIRD_PARTY_NOTICES.md',
  ...(await walk(rendererRoot)),
].map((path) => `package/${path}`);
assertPackEntries(entries);

const manifest = parse(await readFile(join(packageRoot, 'plugin.yaml'), 'utf8'));
const declaredIntegrity = manifest.contributions?.[0]?.surface?.integrity;
const actualIntegrity = sha256Sri(await readFile(join(rendererRoot, 'index.html')));
if (declaredIntegrity !== actualIntegrity) {
  throw new Error(
    `renderer integrity mismatch: manifest=${declaredIntegrity}, actual=${actualIntegrity}`,
  );
}
process.stdout.write(`${JSON.stringify({ ready: true, integrity: actualIntegrity })}\n`);
