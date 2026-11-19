import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { TasteMemoryLifecycleStore } from './TasteMemoryLifecycleStore.js';
import { TasteMemoryReader } from './TasteMemoryReader.js';
import { tasteMemoryId } from './taste-memory-identity.js';
import { resolveCanonicalTasteRoot, type TasteRepository } from './TasteRepository.js';

/** Pin publication and canonical root per operation, preserving private-file and lifecycle checks. */
async function browseReader(
  repository: TasteRepository,
  owner: string,
  privateAccess: boolean,
  lifecycle?: Pick<TasteMemoryLifecycleStore, 'isReadable'>,
) {
  const root = await resolveCanonicalTasteRoot(repository);
  const snapshot = (await repository.publishedSnapshot?.()) ?? null;
  const reader = new TasteMemoryReader(
    { canonicalRoot: () => root, approvalLockKey: () => 'read-only', publishedSnapshot: async () => snapshot },
    owner,
    { lifecycle },
  );
  const directories = privateAccess ? ['docs/taste/vignettes', 'private/taste'] : ['docs/taste/vignettes'];
  const paths: string[] = [];
  for (const directory of directories) {
    if (directory === 'docs/taste/vignettes' && snapshot) {
      paths.push(...(await snapshot.list()));
      continue;
    }
    try {
      paths.push(...(await readdir(join(root, directory))).sort().map((name) => `${directory}/${name}`));
    } catch (error) {
      if (directory !== 'private/taste' || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return { paths: paths.filter((path) => path.endsWith('.md')), reader, snapshot };
}

export async function visibleTasteMemories(
  repository: TasteRepository,
  owner: string,
  privateAccess: boolean,
  lifecycle?: Pick<TasteMemoryLifecycleStore, 'isReadable'>,
) {
  const { paths, reader, snapshot } = await browseReader(repository, owner, privateAccess, lifecycle);
  await snapshot?.prefetch?.(paths);
  const memories = [];
  for (const sourcePath of paths) {
    const memory = await reader.read({ ownerUserId: owner, sourcePath, includeRetired: true });
    if (memory) memories.push(memory);
  }
  return memories.sort(
    (a, b) => b.payload.when.localeCompare(a.payload.when) || a.sourcePath.localeCompare(b.sourcePath),
  );
}

export async function readTasteMemoryById(
  repository: TasteRepository,
  owner: string,
  privateAccess: boolean,
  memoryId: string,
  lifecycle?: Pick<TasteMemoryLifecycleStore, 'isReadable'>,
) {
  const { paths, reader } = await browseReader(repository, owner, privateAccess, lifecycle);
  const sourcePath = paths.find((path) => tasteMemoryId(path) === memoryId);
  return sourcePath ? reader.read({ ownerUserId: owner, sourcePath, includeRetired: true }) : null;
}
