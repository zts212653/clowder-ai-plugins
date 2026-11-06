import type { CommunityEvent, CommunityObjectProjection } from './business/model/index.js';
import { sanitize } from './business/domains/community/issue-analysis/CommunityIssueSanitizer.js';

/** Provider portion of the old Community board. Host assignment/closure actions
 * are not inferred from this installation's private projection. */
export function providerObservation(subjectKey: string, events: readonly CommunityEvent[], projection: CommunityObjectProjection | null) {
  let state: 'open' | 'closed' | 'merged' | 'unknown' = 'unknown';
  let title: string | null = null;
  let lastObservedAt: number | null = null;
  for (const event of events) {
    if (event.subjectKey !== subjectKey) throw new Error('mismatched observation subject');
    if (event.kind.startsWith('issue.') || event.kind.startsWith('pr.')) {
      lastObservedAt = Math.max(lastObservedAt ?? 0, event.at);
      if (typeof event.payload.title === 'string') title = event.payload.title;
      if (['issue.opened', 'issue.reopened', 'pr.opened', 'pr.ready_for_review', 'pr.open_observed'].includes(event.kind)) state = 'open';
      if (['issue.closed', 'pr.closed'].includes(event.kind)) state = 'closed';
      if (event.kind === 'pr.merged') state = 'merged';
    }
  }
  const review = projection?.externalReview;
  const open = projection?.providerOpen;
  const terminal = open ? undefined : projection?.terminalFacts;
  return {
    subjectKey, title, state: open ? 'open' : terminal?.state ?? state, lastObservedAt, eventCount: events.length,
    // Deliberate field projection: no callback principal, verdict or lease.
    headSha: open ? open.headSha : terminal ? terminal.headSha : review?.currentHeadSha ?? null,
    ci: open ? 'unknown' : terminal ? terminal.ci?.status ?? 'unknown' : review?.ci?.headSha === review?.currentHeadSha ? review?.ci?.status ?? null : null,
    cloud: !open && review?.cloud?.headSha === (terminal ? terminal.headSha : review?.currentHeadSha) ? review?.cloud?.status ?? null : null,
    ...(open && projection?.terminalFacts ? { historicalTerminalFacts: projection.terminalFacts } : {}),
    ...(terminal ? { terminalFacts: terminal,
      finalReviews: terminal.headSha ? terminal.reviews.filter(item => item.commitId === terminal.headSha) : [],
    } : {}),
  };
}

/** A pure preview of supplied public text; no draft record or publication. */
export async function previewPublicIssue(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('preview input required');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['title', 'bodyMarkdown'].includes(key))) throw new TypeError('unsupported preview field');
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 500 ||
    typeof input.bodyMarkdown !== 'string' || input.bodyMarkdown.length > 65536) throw new TypeError('invalid preview content');
  const result = sanitize(input.title, input.bodyMarkdown);
  if (!result.passed) throw new Error('preview still contains forbidden patterns');
  return { data: { ...result, saved: false, published: false } };
}
