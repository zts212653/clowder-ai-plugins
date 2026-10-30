import { CollectiveServiceError } from './errors.js';
import { secretMatches } from './persistence.js';
import type { HumanRecord, ServiceState, SessionRecord } from './state.js';

export interface AuthenticatedHuman {
  readonly human: HumanRecord;
  readonly session: SessionRecord;
}

export function resolveSession(state: ServiceState, sessionToken: string): AuthenticatedHuman {
  const session = Object.values(state.sessions).find((candidate) => secretMatches(sessionToken, candidate.tokenDigest));
  const human = session ? state.humans[session.humanId] : undefined;
  if (!session || !human) {
    throw new CollectiveServiceError('AUTHENTICATION_REQUIRED', 'A valid human session is required', 401);
  }
  return { human, session };
}

export function findHumanAuthBinding(state: ServiceState, humanId: string) {
  return Object.values(state.humanAuthBindings).find((binding) => binding.humanId === humanId);
}

export function requireHumanAuthBinding(state: ServiceState, humanId: string) {
  const binding = findHumanAuthBinding(state, humanId);
  if (!binding) {
    throw new CollectiveServiceError(
      'HUMAN_AUTH_REQUIRED',
      'Bind an authenticated Human identity before using the Collective',
      401,
    );
  }
  return binding;
}
