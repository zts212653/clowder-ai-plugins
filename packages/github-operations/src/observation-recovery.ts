import { createHash } from 'node:crypto';
import { consecutiveFailures, type RecoveryAttempt, type RecoveryErrorFacts } from './recovery-attempt.js';
import type { DiagnosticError } from './tracking-diagnostics.js';

interface ObservationRecovery extends RecoveryErrorFacts {
  failures: number; disposition?: 'needs_attention'; reasonCode?: string;
}
const networkCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'ENETDOWN', 'EPIPE']);
/** Only observed transport failures qualify. Invalid records, permissions and arbitrary EOFs do not. */
export function transientObservationError(error: DiagnosticError | undefined, depth = 0): boolean {
  if (!error || depth > 3) return false;
  if (networkCodes.has(String(error.code)) || error.name === 'TimeoutError') return true;
  const text = [error.message, error.stderr].filter(Boolean).join('\n');
  // CI readers deliberately return null for unavailable/partial snapshots. Do
  // not turn that loss of transport detail into a lifetime failure budget.
  if (error.message === 'GitHub CI snapshot unavailable' || error.message === 'GitHub HEAD changed during snapshot; retry without advancing cursors') return true;
  return /\b(?:Get|Head) "https:\/\/api\.github\.com\/[^"\r\n]*": (?:unexpected )?EOF\b/.test(text)
    || /\bPost "https:\/\/api\.github\.com\/graphql": (?:unexpected )?EOF\b/.test(text)
    || /\b(?:connection reset by peer|network is unreachable|TLS handshake timeout|i\/o timeout)\b/i.test(text)
    || /\bHTTP(?:\/[\d.]+)?\s+(?:408|5\d\d)\b/i.test(text)
    || transientObservationError(error.cause, depth + 1);
}

/** Persist one deadline; repeated ticks and cold starts do not create another request. */
export function observationRetryDelay(failures: number, intervalMs: number, scope: string): number {
  const base = Math.min(15 * 60_000, intervalMs * 2 ** Math.min(4, Math.max(0, failures - 1)));
  const fraction = createHash('sha256').update(scope).digest().readUInt16BE(0) / 65535;
  return Math.max(intervalMs, Math.round(base * (0.9 + fraction * 0.1)));
}

export function observationAttempt<T extends ObservationRecovery>(previous: T, outcome: RecoveryAttempt,
  now: number, error?: DiagnosticError): T {
  const next = { ...previous, failures: consecutiveFailures(previous.failures, outcome) };
  if (outcome === 'succeeded') {
    delete next.disposition; delete next.reasonCode; delete next.retryable;
  } else if (outcome === 'failed') {
    next.retryable = transientObservationError(error);
    if (error) { next.lastError = error; next.lastFailureAt = now; }
    if (next.retryable) { delete next.disposition; next.reasonCode = 'github_network_backoff'; }
  }
  return next;
}

/** Upgrade only valid observation failures; corruption and route/authority quarantines remain inert. */
export function resumeLegacyNetworkFailure<T extends ObservationRecovery>(previous: T): T {
  if (previous.retryable !== undefined || previous.disposition !== 'needs_attention'
    || !['github_observation_failed', 'collection_observation_failed', 'migrated_issue_observation_failed'].includes(previous.reasonCode ?? '')
    || !transientObservationError(previous.lastError)) return previous;
  const next = { ...previous, retryable: true, reasonCode: 'github_network_backoff' };
  delete next.disposition;
  return next;
}
