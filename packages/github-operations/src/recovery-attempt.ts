import type { DiagnosticError } from './tracking-diagnostics.js';

export type RecoveryAttempt = 'succeeded' | 'failed' | 'deferred';
export interface RecoveryErrorFacts { lastError?: DiagnosticError; lastFailureAt?: number; retryable?: boolean }

/** Skipping work is neither evidence of a broken subject nor evidence it recovered. */
export function consecutiveFailures(previous: number, outcome: RecoveryAttempt): number {
  return outcome === 'failed' ? previous + 1 : outcome === 'succeeded' ? 0 : previous;
}
