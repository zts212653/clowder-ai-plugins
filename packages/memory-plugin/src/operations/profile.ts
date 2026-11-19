import { profileDispatchSchema } from '@clowder-ai/plugin-memory-contract/profile';
import type { ProfileMemoryLifecycleStore, StoredProfileMemoryEntry } from '../profile/ProfileMemoryLifecycleStore.js';
import { renderUserCapsuleSection } from '../profile/profile-contract.js';

function projectEntry({ path: _path, profileDir: _profileDir, targetPath: _targetPath, ...entry }: StoredProfileMemoryEntry) {
  return entry;
}

export async function dispatchProfile(
  store: ProfileMemoryLifecycleStore,
  runWrite: <T>(work: () => Promise<T>) => Promise<T>,
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
    case 'profile.action_evidence':
      return store.getOwnerActionEvidence(ownerUserId, request.input.memoryId, request.input.requestId);
    case 'profile.mutate':
      return runWrite(async () => {
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
