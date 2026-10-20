import { resolveConsensus } from './business/domains/community/reconciliation/resolveConsensus.js';
import type { TriageEntry, Verdict } from './business/model/index.js';

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('triage input must be an object');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !fields.includes(key))) throw new TypeError('unsupported triage field');
  return input;
}

/** Reuses the original pure consensus rule, never TriageOrchestrator's durable
 * assignment/acceptance writes. Distinct evidence labels do not prove distinct
 * authenticated reviewers. Host governance must admit any formal decision. */
export function recommendTriage(value: unknown) {
  const input = object(value, ['issueType', 'observations']);
  if (!['bug', 'feature', 'enhancement', 'question'].includes(input.issueType as string)) throw new TypeError('invalid issueType');
  if (!Array.isArray(input.observations) || input.observations.length < 1 || input.observations.length > 2) {
    throw new TypeError('one or two triage observations are required');
  }
  const sources = new Set<string>();
  const entries: TriageEntry[] = input.observations.map(value => {
    const observation = object(value, ['sourceId', 'verdict', 'reasonCode']);
    if (typeof observation.sourceId !== 'string' || !observation.sourceId.trim() || observation.sourceId.length > 256) {
      throw new TypeError('sourceId must be a bounded evidence label');
    }
    if (sources.has(observation.sourceId)) throw new TypeError('observations must have distinct sourceIds');
    sources.add(observation.sourceId);
    if (!['WELCOME', 'NEEDS-DISCUSSION', 'POLITELY-DECLINE'].includes(observation.verdict as string)) throw new TypeError('invalid verdict');
    if (observation.reasonCode !== undefined && (typeof observation.reasonCode !== 'string' || observation.reasonCode.length > 256)) {
      throw new TypeError('invalid reasonCode');
    }
    return { catId: observation.sourceId, verdict: observation.verdict as Verdict, questions: [], timestamp: 0,
      ...(typeof observation.reasonCode === 'string' ? { reasonCode: observation.reasonCode } : {}) };
  });
  const consensus = resolveConsensus(entries);
  return { data: {
    decision: entries.length === 1 && input.issueType !== 'bug' ? 'needs-more-observations' : consensus.verdict,
    ...(consensus.reasonCode ? { reasonCode: consensus.reasonCode } : {}),
    provenance: 'supplied-observations', requiresAuthenticatedDecision: true,
  } };
}
