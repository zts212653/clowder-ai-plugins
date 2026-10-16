import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
export const SHARED_FILES = ['native-framing.mjs', 'pairing-record.mjs', 'native-socket-lease.mjs'];
export async function artifactDigest(source) {
  const hash = createHash('sha512');
  async function append(directory, prefix) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const label = `${prefix}/${entry.name}`,
        path = join(directory, entry.name);
      if (entry.isDirectory()) await append(path, label);
      else if (entry.isFile()) {
        const bytes = await readFile(path);
        hash.update(`${label}\0${bytes.length}\0`);
        hash.update(bytes);
      } else throw new Error('ARTIFACT_SYMLINK_NOT_ALLOWED');
    }
  }
  await append(source, 'tripo-studio');
  for (const file of SHARED_FILES) {
    hash.update(file);
    hash.update(await readFile(join(source, '../cloud-cat-personal-host/native-host', file)));
  }
  return hash.digest('hex');
}
