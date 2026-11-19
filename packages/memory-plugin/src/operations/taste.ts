import { tasteBrowseDispatchSchema } from '@clowder-ai/plugin-memory-contract/taste';
import type Database from 'better-sqlite3';
import type { MemoryHostPorts } from '../host-port.js';
import { TasteMemoryLifecycleStore } from '../taste/TasteMemoryLifecycleStore.js';
import type { TasteMemoryReadResult } from '../taste/TasteMemoryReader.js';
import { FileTasteRepository } from '../taste/TasteRepository.js';
import { readTasteMemoryById, visibleTasteMemories } from '../taste/taste-browse-reader.js';

export function createTasteDispatch(db: Database.Database, projectRoot: string, source: MemoryHostPorts['memorySource']) {
  const repository = new FileTasteRepository(projectRoot);
  const lifecycle = new TasteMemoryLifecycleStore(db);
  return async (value: unknown) => {
    const request = tasteBrowseDispatchSchema.parse(value);
    const { userId: owner, viewer, privateOwnerAccess = false } = await source.caller();
    if (viewer.type !== 'user') throw new Error('taste_owner_scope_required');
    const project = (entry: TasteMemoryReadResult) => ({
      ...entry,
      takeawayCandidate: lifecycle.candidateFor(owner, entry.sourcePath, entry.revision),
    });
    if (request.operation === 'taste.list') {
      return (await visibleTasteMemories(repository, owner, privateOwnerAccess, lifecycle)).map(project);
    }
    const { memoryId } = request.input;
    if (request.operation === 'taste.action_source') {
      const known = lifecycle.sourcePathForMemoryId(owner, memoryId);
      if (known) return privateOwnerAccess || known.startsWith('docs/taste/vignettes/') ? known : null;
    }
    const entry = await readTasteMemoryById(repository, owner, privateOwnerAccess, memoryId, lifecycle);
    if (request.operation === 'taste.action_source') return entry?.sourcePath ?? null;
    return entry ? project(entry) : null;
  };
}
