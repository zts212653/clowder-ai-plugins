import type { CollectiveMemberDirectory } from '../contracts/index.js';
import { requireHumanAuthBinding, requireMembership, resolveSession } from './identity-store.js';
import type { ServiceState } from './state.js';
import { projectMemberDirectory } from './member-projection.js';

export function readMemberDirectory(
  state: ServiceState,
  sessionToken: string,
  collectiveId: string,
): CollectiveMemberDirectory {
  const { human } = resolveSession(state, sessionToken);
  requireHumanAuthBinding(state, human.humanId);
  requireMembership(state, collectiveId, human.humanId);
  return projectMemberDirectory(state, collectiveId);
}
