import { sourceDigest, type MigrationSource } from './migration-source.js';
import { legacyTasks } from './operational-source-tasks.js';
import { legacyRepositories } from './operational-source-repositories.js';
export interface LegacyReadPort {
  read(command: string, ...args: string[]): Promise<unknown>;
}
export interface LegacySourceScope {
  ownerUserId: string;
  keyPrefix: string;
  repositories: readonly string[];
  excludedTaskIds: readonly string[];
  sourceRef: string;
  oldWriterProofRef: string;
}
export async function collectLegacyGitHubSource(
  reader: LegacyReadPort,
  scope: LegacySourceScope,
  signal: AbortSignal,
): Promise<MigrationSource> {
  const tasks = await legacyTasks(reader, scope, signal),
    repos = await legacyRepositories(reader, scope, signal);
  signal.throwIfAborted();
  return {
    v: 1,
    id: 'legacy-redis:' + sourceDigest({ scope, membership: tasks.members, claims: repos.claims }),
    userId: scope.ownerUserId,
    sourceRef: scope.sourceRef,
    capturedAt: Date.now(),
    oldWriter: 'absent',
    coverage: {
      tracking: 'complete',
      repositories: 'complete',
      progress: 'complete',
      'pending-receipts': 'complete',
      'authority-retention': 'complete',
    },
    tasks: tasks.tasks,
    repositories: repos.repositories,
    receipts: tasks.receipts,
    retainedAuthorityRefs: [scope.oldWriterProofRef, ...tasks.refs],
    unresolvedRepositoryDeliveries: repos.unresolved,
  };
}
