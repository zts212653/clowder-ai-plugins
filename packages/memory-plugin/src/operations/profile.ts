import { profileDispatchSchema } from '@clowder-ai/plugin-memory-contract/profile';
import type { ProfileMemoryLifecycleStore, StoredProfileMemoryEntry } from '../profile/ProfileMemoryLifecycleStore.js';
import { readProfileUsage } from '../profile/ProfileUsageReader.js';
import { renderUserCapsuleSection } from '../profile/profile-contract.js';
import { readProfileProvenance } from '../profile/profile-provenance.js';
import type { openMemoryStorage } from '../open-memory-storage.js';

function projectEntry({ path: _path, profileDir: _profileDir, targetPath: _targetPath, ...entry }: StoredProfileMemoryEntry) {
  return entry;
}

export async function dispatchProfile(
  store: ProfileMemoryLifecycleStore,
  storage: Pick<Awaited<ReturnType<typeof openMemoryStorage>>, 'db' | 'runWrite'>,
  source: {
    caller(): Promise<{ userId: string; viewer: { type: 'cat' | 'user' } }>;
    assertCurrent(): Promise<void>;
  },
  value: unknown,
) {
  const request = profileDispatchSchema.parse(value);
  const { userId: ownerUserId, viewer } = await source.caller();
  if (viewer.type !== 'user') throw new Error('profile_owner_scope_required');
  switch (request.operation) {
    case 'profile.list':
      return store.list(ownerUserId).map(projectEntry);
    case 'profile.get': {
      const entry = store.get(ownerUserId, request.input.memoryId);
      return entry ? projectEntry(entry) : null;
    }
    case 'profile.provenance':
    case 'profile.usage': {
      const entry = store.get(ownerUserId, request.input.memoryId);
      if (!entry) return { outcome: 'not_available' as const };
      if (entry.revision !== request.input.revision) return { outcome: 'stale_revision' as const };
      return request.operation === 'profile.provenance'
        ? { outcome: 'found' as const, coordinates: readProfileProvenance(entry) }
        : { outcome: 'found' as const, usage: readProfileUsage(storage.db, ownerUserId, entry) };
    }
    case 'profile.recover':
      return storage.runWrite(async () => {
        const { memoryId, command } = request.input;
        const evidence = store.getOwnerActionEvidence(ownerUserId, memoryId, command.requestId);
        if (!evidence?.applied || evidence.action !== command.action || evidence.commandDigest !== store.commandDigest(command)) {
          return null;
        }
        if (command.action === 'hard_forget') {
          await source.assertCurrent();
          store.finishHardForgetCleanup(ownerUserId, memoryId, command.requestId);
          return { action: command.action };
        }
        return evidence.revision ? { action: command.action, revision: evidence.revision } : null;
      });
    case 'profile.mutate':
      return storage.runWrite(async () => {
        const { memoryId, command } = request.input;
        if (memoryId === 'capsule' && command.action === 'replace_content') {
          try {
            if (!renderUserCapsuleSection(command.content)) return { outcome: 'invalid_content' as const };
          } catch {
            return { outcome: 'invalid_content' as const };
          }
        }
        await source.assertCurrent();
        const result = command.action === 'replace_content'
          ? store.replaceContent({ ownerUserId, memoryId, command })
          : store.hardForget({ ownerUserId, memoryId, command });
        return result.outcome === 'applied' ? { ...result, entry: projectEntry(result.entry) } : result;
      });
  }
}
