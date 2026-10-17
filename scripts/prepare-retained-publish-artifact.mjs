import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readRetainedSdkClosures } from './retained-sdk-fixture.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

// These exact archived dependencies are already pinned by production consumers.
// Their authenticated original bytes, not a rebuild of the current workspace,
// are the only admissible inputs to the protected publisher's retained mode.
export async function prepareRetainedPublication({ directory, artifactPath, destination, root = repoRoot }) {
  const candidates = (await readRetainedSdkClosures()).flatMap(closure =>
    ['sdk', 'contract'].map(kind => {
      const name = `@clowder-ai/plugin-${kind}`;
      const identity = closure[kind];
      const filename = `clowder-ai-plugin-${kind}-${identity.version}.tgz`;
      return { name, ...identity, filename, directory: `packages/plugin-${kind}`,
        artifactPath: `scripts/fixtures/retained-sdk/${filename}` };
    }));
  const candidate = candidates.find(item => item.directory === directory && item.artifactPath === artifactPath);
  if (!candidate) throw new Error('retained publication requires an authenticated SDK/contract archive identity');
  const bytes = await readFile(join(root, candidate.artifactPath));
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (integrity !== candidate.integrity) throw new Error('retained publication archive integrity mismatch');
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, candidate.filename), bytes, { flag: 'wx' });
  return { name: candidate.name, version: candidate.version, filename: candidate.filename,
    integrity, size: bytes.length, shasum: createHash('sha1').update(bytes).digest('hex'),
    sourceSha256: createHash('sha256').update(bytes).digest('hex'), retained: true };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [directory, artifactPath, destination] = process.argv.slice(2);
  process.stdout.write(`${JSON.stringify([await prepareRetainedPublication({ directory, artifactPath, destination })])}\n`);
}
