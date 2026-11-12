/**
 * CommunityProjector — consumes events → calls state machine → writes projection
 * (F168 Phase A — Task 4)
 *
 * Responsibilities:
 *  - apply(event): read projection → transition() → handle side-effects → save
 *  - rebuild(subjectKey): delete projection → replay full log
 *  - rebuildAll(): rebuild all subjects via listSubjects()
 *
 * Invariants:
 *  - Events are NEVER deleted from the log (event facts are immutable).
 *  - A rejected transition (closure_invariant) records lastRejectedEvent but
 *    does NOT change projection state.
 *  - case.waived side-effect: stores closureWaiver on projection (no state change).
 *  - case.reported side-effect: sets lastPublicCommentAt to event.at.
 */

import type {
  CommunityEvent,
  CommunityObjectProjection,
  CommunityObjectState,
  IssueFixEvidence,
} from '../../model/index.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { canonicalizeCommunitySubjectKey } from '../../model/index.js';
import type { ICommunityEventLog } from './CommunityEventLog.js';
import type { ICommunityObjectStore } from './CommunityObjectStore.js';
import { parseLinkedIssues } from './community-link-parser.js';
import { isExactSuppressedCommunityEvent, transition } from './community-state-machine.js';
import {
  applyExternalReviewProjectionEvent,
  isExternalReviewEventKind,
  isExternalReviewTerminalEventKind,
} from './external-review/external-review-projector.js';
import { selectIssueFixReadiness } from './issue-analysis/issue-fix-evidence.js';
import { applyProviderPeriodObservation, applyTerminalProviderFacts } from './external-review/external-review-aggregate.js';
import { currentProviderFacts, isProviderPeriodEvent, reduceProviderEvent, reduceProviderHistory } from './provider-period.js';

function issueFixEvidenceFromEvent(event: CommunityEvent): IssueFixEvidence | null {
  if (event.kind === 'issue.commented' || event.kind === 'case.fix_evidence_recorded') {
    const decision = selectIssueFixReadiness({ events: [event] });
    return decision.kind === 'ready' ? decision.evidence : null;
  }
  if (event.kind !== 'pr.merged' || typeof event.payload.linkedPr !== 'string') return null;
  const linked = /^pr:(.+)#(\d+)$/.exec(event.payload.linkedPr);
  if (!linked) return null;
  const number = Number(linked[2]);
  return {
    kind: 'pull_request',
    url: `https://github.com/${linked[1]}/pull/${number}`,
    number,
  };
}

// ---------------------------------------------------------------------------
// Parse subjectKey → repo/type/number
// ---------------------------------------------------------------------------

function parseSubjectKey(subjectKey: string): {
  repo: string;
  type: 'issue' | 'pr';
  number: number;
} {
  // Format: "issue:owner/repo#42"  |  "pr:owner/repo#7"
  const match = /^(issue|pr):(.+)#(\d+)$/.exec(subjectKey);
  if (!match) throw new Error(`Invalid subjectKey: ${subjectKey}`);
  return {
    type: match[1] as 'issue' | 'pr',
    repo: match[2],
    number: parseInt(match[3], 10),
  };
}

// ---------------------------------------------------------------------------
// Default projection factory
// ---------------------------------------------------------------------------

function createProjection(
  subjectKey: string,
  initialState: CommunityObjectState,
  now: number,
): CommunityObjectProjection {
  const { repo, type, number } = parseSubjectKey(subjectKey);
  return {
    repo,
    type,
    number,
    subjectKey,
    state: initialState,
    ownerThreadId: null,
    ownerRole: null,
    nextOwner: 'none',
    lastExternalActivityAt: null,
    lastPublicCommentAt: null,
    linkedIssues: [],
    linkedPrs: [],
    closureWaiver: null,
    issueFixEvidence: null,
    externalReview: null,
    appliedEventCount: 0,
    lastRejectedEvent: null,
    deliveryCursor: null,
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Projector
// ---------------------------------------------------------------------------

/** Shared by the background and request projectors of ONE active module.
 * Stores and request guards remain separate; this owns only subject ordering.
 * It is not a cross-process lock or a replacement for Host storage revisions. */
export class CommunityProjectionOperations {
  private readonly subjectOperations = new Map<string, Promise<unknown>>();
  private readonly followUpsInFlight = new Map<string, Promise<void>>();
  private readonly followUpContext = new AsyncLocalStorage<ReadonlySet<string>>();
  async runFollowUp(subject: string, id: string, operation: () => Promise<void>): Promise<boolean> {
    const key = JSON.stringify([canonicalizeCommunitySubjectKey(subject), id]);
    const context = this.followUpContext.getStore() ?? new Set<string>();
    if (context.has(key)) return false;
    const existing = this.followUpsInFlight.get(key);
    // A nested effect must not await another root's reciprocal effect. Its
    // durable record remains owned by that root; top-level callers can join it.
    if (existing) { if (context.size) return false; await existing; return true; }
    const running = this.followUpContext.run(new Set([...context, key]), () => Promise.resolve().then(operation));
    this.followUpsInFlight.set(key, running);
    try { await running; return true; } finally { this.followUpsInFlight.delete(key); }
  }
  async run<T>(subjectKey: string, operation: () => Promise<T>): Promise<T> {
    const canonicalSubjectKey = canonicalizeCommunitySubjectKey(subjectKey);
    const predecessor = this.subjectOperations.get(canonicalSubjectKey);
    const predecessorSettled = Promise.resolve(predecessor).then(
      () => undefined,
      () => undefined,
    );
    const current = predecessorSettled.then(operation);
    this.subjectOperations.set(canonicalSubjectKey, current);
    try {
      return await current;
    } finally {
      if (this.subjectOperations.get(canonicalSubjectKey) === current) {
        this.subjectOperations.delete(canonicalSubjectKey);
      }
    }
  }

}

export class CommunityProjector {
  private readonly rebuildInFlight = new Map<string, Promise<void>>();
  constructor(
    private readonly eventLog: ICommunityEventLog,
    private readonly objectStore: ICommunityObjectStore,
    private readonly operations = new CommunityProjectionOperations(),
    private readonly effects: 'normal' | 'projection-only' = 'normal',
  ) {}

  /**
   * Apply a single event to the projection.
   * The event MUST already be in the event log (append first).
   */
  async apply(event: CommunityEvent): Promise<void> {
    await this.applyChecked(event);
  }

  /** Fold the committed prefix in journal order, regardless of producer apply
   * order. The requested event's decision is its decision at that position. */
  async applyChecked(event: CommunityEvent): Promise<boolean> {
    try {
      const result = await this.runSubjectOperation(event.subjectKey, async () => {
        const current = await this.objectStore.get(event.subjectKey);
        const cursor = current?.journalCursor;
        if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) throw new Error('Invalid projection journal cursor; rebuild required');
        if (this.effects === 'projection-only') return this.projectOnly(event.subjectKey, await this.eventLog.read(event.subjectKey), current, event.sourceEventId);
        const pending = await this.eventLog.read(event.subjectKey, cursor ?? 0);
        if (cursor === undefined || !pending.some(item => item.sourceEventId === event.sourceEventId)) {
          const history = cursor === undefined ? pending : await this.eventLog.read(event.subjectKey);
          if (!history.some(item => item.sourceEventId === event.sourceEventId)) throw new Error('Projection event must be committed to its subject journal');
          await this.preserveLegacyLinks(current);
          await this.objectStore.delete(event.subjectKey);
          const all = await this.eventLog.read(event.subjectKey);
          const result = await this.fold(all, 0, event.sourceEventId);
          return result;
        }
        return this.fold(pending, cursor, event.sourceEventId);
      });
      return result.accepted;
    } finally { await this.drainFollowUps(event.subjectKey); }
  }

  /** Older caches may contain cross-subject links absent from their PR log.
   * Recover only links proven by the source issue bootstrap, at the current tail;
   * never seed later metadata into an earlier merge. */
  private async preserveLegacyLinks(existing: CommunityObjectProjection | null): Promise<void> {
    if (this.effects === 'projection-only' || !existing || existing.type !== 'pr') return;
    for (const number of existing.linkedIssues) {
      const events = await this.eventLog.read(`issue:${existing.repo}#${number}`);
      for (const event of events) {
        const original = event.payload.originalRecord as Record<string, unknown> | undefined;
        if (event.kind === 'case.bootstrap' && Array.isArray(original?.linkedPrNumbers) && original.linkedPrNumbers.includes(existing.number)) {
          await this.eventLog.append(this.issueLinkEvent(event, existing.number));
        }
      }
    }
  }

  /** Historical fact repair stages a pure replay and commits one replacement.
   * Original pending operations and links remain data; this caller cannot run
   * other workflows, and an interrupted replay cannot discard their records. */
  private async projectOnly(subject: string, history: CommunityEvent[], previous: CommunityObjectProjection | null, requestedId?: string) {
    if (requestedId && !history.some(event => event.sourceEventId === requestedId)) throw new Error('Projection event must be committed to its subject journal');
    const boundary = previous?.journalCursor ?? history.length;
    if (!Number.isSafeInteger(boundary) || boundary < 0 || boundary > history.length) throw new Error('Invalid projection journal cursor');
    const state: { value: CommunityObjectProjection | null } = { value: null };
    const staged = new CommunityProjector(this.eventLog, {
      get: async key => key === subject ? state.value : null,
      save: async value => { if (value.subjectKey !== subject) throw new Error('Projection replay escaped subject'); state.value = value; },
      delete: async () => { state.value = null; }, listSubjectKeys: async () => state.value ? [subject] : [],
    }, this.operations, 'projection-only');
    const prefix = await staged.fold(history.slice(0, boundary), 0, requestedId, history.length);
    if (previous) state.value = { ...(state.value ?? createProjection(subject, 'new', previous.createdAt)),
      linkedIssues: [...new Set([...(state.value?.linkedIssues ?? []), ...previous.linkedIssues])] };
    const tail = await staged.fold(history.slice(boundary), boundary, requestedId, boundary);
    if (state.value) {
      const pending = [...new Map([...(state.value.pendingFollowUps ?? []), ...(previous?.pendingFollowUps ?? [])]
        .map(item => [JSON.stringify([item.sourceEventId, item.kind]), item])).values()];
      await this.objectStore.save({ ...state.value, ...(pending.length ? { pendingFollowUps: pending } : {}) });
    }
    return { accepted: prefix.accepted || tail.accepted };
  }

  private async fold(events: readonly CommunityEvent[], cursor: number, requestedId?: string, effectsAfter = 0) {
    let accepted = false;
    for (const [index, event] of events.entries()) {
      const nextCursor = cursor + index + 1;
      const result = await this.applySubject(event, nextCursor, nextCursor > effectsAfter);
      if (event.sourceEventId === requestedId) accepted = result.accepted;
      // Ignored/rejected events which made no state write still consume one
      // journal position. State-changing writes carry this cursor atomically.
      const projected = await this.objectStore.get(event.subjectKey);
      if (projected?.journalCursor !== nextCursor) await this.objectStore.save({
        ...(projected ?? createProjection(event.subjectKey, 'new', event.at)), journalCursor: nextCursor,
      });
    }
    return { accepted };
  }

  async catchUp(subject: string): Promise<void> {
    try {
      await this.runSubjectOperation(subject, async () => {
        const current = await this.objectStore.get(subject);
        if (this.effects === 'projection-only') { await this.projectOnly(subject, await this.eventLog.read(subject), current); return; }
        if (current?.journalCursor === undefined) {
          await this.preserveLegacyLinks(current);
          await this.objectStore.delete(subject);
        }
        const cursor = current?.journalCursor ?? 0;
        const tail = await this.eventLog.read(subject, cursor);
        await this.fold(tail, cursor);
      });
    } finally { await this.drainFollowUps(subject); }
  }

  resumeFollowUps(subject: string): Promise<void> { return this.drainFollowUps(subject); }

  private async applySubject(event: CommunityEvent, journalCursor: number, retainNewEffects: boolean): Promise<{ accepted: boolean; followUps: NonNullable<CommunityObjectProjection['pendingFollowUps']> }> {
    const followUps: NonNullable<CommunityObjectProjection['pendingFollowUps']> = [];
    const existing = await this.objectStore.get(event.subjectKey);
    const now = typeof event.payload.linkedPr === 'string' ? Math.max(event.at, existing?.updatedAt ?? event.at) : event.at;
    let proj: CommunityObjectProjection = existing ?? createProjection(event.subjectKey, 'new', now);
    const save = (projection: CommunityObjectProjection) => {
      const effects = [...(projection.pendingFollowUps ?? []), ...(retainNewEffects ? followUps : [])];
      const pending = [...new Map(effects.map(item => [JSON.stringify([item.sourceEventId, item.kind]), item])).values()];
      return this.objectStore.save({ ...projection, journalCursor, ...(pending.length ? { pendingFollowUps: pending } : {}) });
    };

    if (proj.type === 'pr' && (isProviderPeriodEvent(event) || event.kind === 'pr.review_submitted' && !!proj.terminalFacts)) {
      const prior = proj.providerPeriod?.floorObservedAt !== undefined && proj.providerPeriod.floorUpdatedAt !== undefined
        ? { state: proj.providerPeriod, facts: proj.terminalFacts }
        : reduceProviderHistory((await this.eventLog.read(event.subjectKey)).slice(0, journalCursor - 1));
      const decision = reduceProviderEvent(prior, event);
      if (!decision.accepted) return { accepted: false, followUps };
      if (decision.value.state) proj = { ...proj, providerPeriod: decision.value.state,
        ...(decision.value.facts ? { terminalFacts: decision.value.facts } : {}) };
      if (isProviderPeriodEvent(event)) {
        const { providerOpen, ...withoutOpen } = proj;
        proj = withoutOpen;
        const period = decision.value.state!;
        if (period.state === 'open') proj = { ...proj, providerOpen: { headSha: period.headSha!, observedAt: event.at,
          ...(period.observedAt !== null ? { providerObservedAt: period.observedAt } : {}),
          ...(period.updatedAt ? { providerUpdatedAt: period.updatedAt } : {}) } };
        if (!currentProviderFacts(decision.value) && period.enrolled) proj = { ...proj,
          externalReview: applyProviderPeriodObservation(proj.externalReview, period.headSha, event.at) };
        if (event.kind === 'pr.open_observed' || event.kind === 'pr.terminal_observed') {
          const facts = currentProviderFacts(decision.value);
          await save({ ...proj, externalReview: period.state === 'open'
            ? applyProviderPeriodObservation(proj.externalReview, period.headSha!, event.at)
            : facts ? applyTerminalProviderFacts(proj.externalReview, facts) : proj.externalReview,
            appliedEventCount: proj.appliedEventCount + 1, updatedAt: Math.max(proj.updatedAt, now) });
          return { accepted: true, followUps };
        }
      }
    }

    if (event.kind === 'pr.issue_linked') {
      const number = event.payload.issueNumber;
      if (proj.type !== 'pr' || !Number.isSafeInteger(number) || (number as number) < 1) return { accepted: false, followUps };
      const sourceSubject = `issue:${proj.repo}#${number}`;
      if (event.payload.sourceSubjectKey !== sourceSubject) return { accepted: false, followUps };
      const source = (await this.eventLog.read(sourceSubject)).find(item => item.sourceEventId === event.payload.sourceEventId);
      const original = source?.payload.originalRecord as Record<string, unknown> | undefined;
      if (source?.kind !== 'case.bootstrap' || !Array.isArray(original?.linkedPrNumbers) || !original.linkedPrNumbers.includes(proj.number)) return { accepted: false, followUps };
      if (proj.state === 'fixed') followUps.push({ sourceEventId: event.sourceEventId, kind: 'merge-cascade', numbers: [number as number] });
      await save({ ...proj, linkedIssues: [...new Set([...proj.linkedIssues, number as number])], appliedEventCount: proj.appliedEventCount + 1 });
      return { accepted: true, followUps };
    }
    // A late derived association cannot reopen a reported/closed native issue.
    if (proj.type === 'issue' && event.kind === 'pr.merged' && typeof event.payload.linkedPr === 'string' &&
        ['reported', 'closed', 'declined'].includes(proj.state)) return { accepted: false, followUps };

    // F168 Phase F-Step3: external review lifecycle is an orthogonal aggregate
    // on the same rebuildable projection. It does not mutate the generic case
    // state and never executes wake/GitHub side effects during replay.
    if (isExternalReviewEventKind(event.kind)) {
      // An open-subject observation/assignment may have been queued before the
      // terminal snapshot. It cannot reopen work after the provider fence.
      if (proj.terminalFacts || proj.externalReview?.lifecycle === 'terminal' ||
          ['fixed', 'reported', 'closed', 'declined'].includes(proj.state)) return { accepted: false, followUps };
      const result = applyExternalReviewProjectionEvent(proj.externalReview, event);
      if (!result.ok) return { accepted: false, followUps };
      const externalReviewUpdated: CommunityObjectProjection = {
        ...proj,
        externalReview: result.value,
        appliedEventCount: proj.appliedEventCount + 1,
        lastRejectedEvent: null,
        updatedAt: now,
      };
      // F168 fix (clowder-ai#1511): case.external_review_assigned carries reviewer
      // identity that must be projected as top-level ownership. Without this,
      // coordinator-admitted cases (no preceding case.routed) have null ownership
      // and verdict bootstrap Case 1 fails with 503 projection_unavailable.
      if (event.kind === 'case.external_review_assigned') {
        const p = event.payload as Record<string, unknown>;
        if (typeof p.reviewerThreadId === 'string') externalReviewUpdated.ownerThreadId = p.reviewerThreadId;
        if (typeof p.reviewerCatId === 'string') externalReviewUpdated.ownerRole = p.reviewerCatId;
      }
      await save(externalReviewUpdated);
      return { accepted: true, followUps };
    }

    const snapshot = {
      lastPublicCommentAt: proj.lastPublicCommentAt,
      closureWaiver: proj.closureWaiver,
    };

    const result = transition(proj.state, event, snapshot);
    const exactSuppressed = event.classification === 'informational' && isExactSuppressedCommunityEvent(event);

    if (!result.ok) {
      if (event.classification === 'informational') {
        // Internal calibration events (eval records) are not external activity —
        // skip projection entirely so rebuild() doesn't corrupt lastExternalActivityAt.
        if (event.kind === 'case.route_decision_eval' || exactSuppressed) {
          return { accepted: true, followUps };
        }
        // Cloud R2 P2b: informational activity events (issue.commented, issue.labeled,
        // pr.review_submitted) have no state-machine transition. Do NOT set lastRejectedEvent
        // (that would pollute observability data with benign activity). Instead, update
        // lastExternalActivityAt so the community board can surface the latest activity time.
        const updated: CommunityObjectProjection = {
          ...proj,
          lastExternalActivityAt: event.at,
          issueFixEvidence: issueFixEvidenceFromEvent(event) ?? proj.issueFixEvidence,
          updatedAt: now,
        };
        await save(updated);
        return { accepted: true, followUps };
      }
      // State-changing event rejected — record for observability, do not change state
      const updated: CommunityObjectProjection = {
        ...proj,
        lastRejectedEvent: event,
        updatedAt: now,
      };
      await save(updated);
      return { accepted: false, followUps };
    }

    // Accepted — apply side effects then update state
    const updated: CommunityObjectProjection = {
      ...proj,
      state: result.next,
      appliedEventCount: proj.appliedEventCount + 1,
      lastRejectedEvent: null,
      updatedAt: now,
    };
    if (proj.externalReview && isExternalReviewTerminalEventKind(event.kind)) {
      const externalReviewResult = applyExternalReviewProjectionEvent(proj.externalReview, event);
      if (externalReviewResult.ok) updated.externalReview = externalReviewResult.value;
    }
    if (!exactSuppressed) {
      updated.issueFixEvidence = issueFixEvidenceFromEvent(event) ?? updated.issueFixEvidence;
    }

    // Side-effect: informational events (issue.commented, pr.review_submitted, etc.)
    // always update lastExternalActivityAt, even when they cause a state transition
    // (e.g. awaiting_external → in_progress restore on external actor comment).
    if (event.classification === 'informational' && !exactSuppressed) {
      updated.lastExternalActivityAt = event.at;
    }

    // Side-effect: case.reported → set lastPublicCommentAt
    if (event.kind === 'case.reported') {
      updated.lastPublicCommentAt = event.at;
    }

    // Side-effect: case.waived → store waiver payload
    if (event.kind === 'case.waived') {
      const p = event.payload as { reason: string; actor: string; evidence: string };
      updated.closureWaiver = { reason: p.reason, actor: p.actor, evidence: p.evidence };
    }

    // Side-effect: case.bootstrap → set ownerThreadId / ownerRole / linkedPrs from payload
    if (event.kind === 'case.bootstrap') {
      const p = event.payload as Record<string, unknown>;
      if (typeof p.ownerThreadId === 'string') updated.ownerThreadId = p.ownerThreadId;
      if (typeof p.ownerRole === 'string') updated.ownerRole = p.ownerRole;

      // P1-4 fix: extract linkedPrNumbers from originalRecord and populate issue linkedPrs
      const originalRecord = p.originalRecord as Record<string, unknown> | undefined;
      const rawLinkedPrs = originalRecord?.linkedPrNumbers;
      if (Array.isArray(rawLinkedPrs) && rawLinkedPrs.length > 0) {
        const prNums: number[] = rawLinkedPrs.filter((n): n is number => typeof n === 'number');
        updated.linkedPrs = [...new Set([...updated.linkedPrs, ...prNums])];
        // Cross-populate after releasing this subject's fence. The target PR then
        // enters its own fence, avoiding reciprocal issue↔PR lock ordering.
        followUps.push({ sourceEventId: event.sourceEventId, kind: 'bootstrap-links', numbers: prNums });
      }
    }

    // Side-effect: case.routed → capture ownerRole / ownerThreadId from payload
    if (event.kind === 'case.routed') {
      const p = event.payload as Record<string, unknown>;
      if (typeof p.ownerThreadId === 'string') updated.ownerThreadId = p.ownerThreadId;
      if (typeof p.ownerRole === 'string') updated.ownerRole = p.ownerRole;
    }

    // Side-effect: pr.opened → parse PR body for closing keywords → populate linkedIssues
    // This fixes the Phase A cascade dead-穴: linked issues discovered via body parsing
    // (not bootstrap) now receive the pr.merged cascade when the PR is later merged.
    if (event.kind === 'pr.opened') {
      const p = event.payload as Record<string, unknown>;
      // Cloud R4 P1-2: GitHub only auto-closes issues for PRs targeting the default branch.
      // isDefaultBranchPr=false → skip closing-keyword parsing (release-branch PRs must not
      // mark issues fixed). undefined = backward-compat (old events without the field) → parse.
      if (p.isDefaultBranchPr !== false) {
        const linked = parseLinkedIssues(p.body as string | null | undefined);
        if (linked.length > 0) {
          updated.linkedIssues = [...new Set([...updated.linkedIssues, ...linked])];
        }
      }
    }

    // Cloud R2 P2a: pr.merged → also parse body for late-added closing keywords
    // When a PR is opened without closing keywords and the author edits the description
    // before merging, the pr.merged payload includes the current body. Parse it here so the
    // cascade below can reach issues that were not in linkedIssues at open time.
    // Cloud R4 P1-1: body-enrichment events (sourceEventId ending in :body-enrichment) also
    // reach this branch; they carry the same kind='pr.merged' but with a distinct event id,
    // allowing late-discovered linked issues to be cascaded after the poller-won-race scenario.
    if (event.kind === 'pr.merged') {
      const p = event.payload as Record<string, unknown>;
      // Cloud R4 P1-2: same default-branch gate as pr.opened — skip on non-default-branch PRs.
      if (p.isDefaultBranchPr !== false && p.body !== null && p.body !== undefined) {
        const linked = parseLinkedIssues(p.body as string | null | undefined);
        if (linked.length > 0) {
          updated.linkedIssues = [...new Set([...updated.linkedIssues, ...linked])];
        }
      }
    }

    // F168 Phase A: cascade pr.merged → linked issues → fixed
    // linkedIssues contains issue NUMBERS (same repo as PR). Cascade only on fresh apply.
    if (event.kind === 'pr.merged' && updated.linkedIssues.length > 0) {
      followUps.push({ sourceEventId: event.sourceEventId, kind: 'merge-cascade', numbers: updated.linkedIssues });
    }
    await save(updated);
    return { accepted: true, followUps };
  }

  /**
   * Cross-populate linked PR projections from a case.bootstrap event.
   * Extracted as a private method so rebuildAll can re-run it after all subjects
   * are rebuilt, ensuring order-independence.
   */
  private issueLinkEvent(source: CommunityEvent, prNumber: number): CommunityEvent {
    const { repo, number } = parseSubjectKey(source.subjectKey);
    return { sourceEventId: `${source.sourceEventId}:link:pr:${repo}#${prNumber}`, subjectKey: `pr:${repo}#${prNumber}`,
      kind: 'pr.issue_linked', classification: 'informational', at: source.at,
      payload: { issueNumber: number, sourceSubjectKey: source.subjectKey, sourceEventId: source.sourceEventId } };
  }

  private async applyBootstrapCrossPopulate(event: CommunityEvent, prNums: number[]): Promise<void> {
    if (parseSubjectKey(event.subjectKey).type !== 'issue') return;
    for (const number of prNums) {
      const linked = this.issueLinkEvent(event, number);
      await this.eventLog.append(linked);
      await this.apply(linked);
    }
  }

  private async cascadeMergedPr(event: CommunityEvent, linkedIssues: number[]): Promise<void> {
    const { repo } = parseSubjectKey(event.subjectKey);
    for (const number of linkedIssues) {
      const subjectKey = `issue:${repo}#${number}`;
      const cascade: CommunityEvent = { sourceEventId: `${event.sourceEventId}:cascade:${subjectKey}`, subjectKey,
        kind: 'pr.merged', classification: 'state-changing', at: event.at,
        payload: { linkedPr: event.subjectKey, title: event.payload.title ?? '' } };
      const history = await this.eventLog.read(subjectKey);
      if (!history.some(item => item.sourceEventId === cascade.sourceEventId)) {
        const current = await this.objectStore.get(subjectKey);
        if (current && ['reported', 'closed', 'declined'].includes(current.state)) continue;
      }
      await this.eventLog.append(cascade);
      await this.apply(cascade);
    }
  }

  private async drainFollowUps(subject: string): Promise<void> {
    if (this.effects === 'projection-only') return;
    for (;;) {
      const pending = await this.runSubjectOperation(subject, async () => (await this.objectStore.get(subject))?.pendingFollowUps?.[0]);
      if (!pending) return;
      const ran = await this.operations.runFollowUp(subject, JSON.stringify([pending.sourceEventId, pending.kind]), async () => {
        const event = (await this.eventLog.read(subject)).find(item => item.sourceEventId === pending.sourceEventId);
        if (!event) throw new Error('Pending projection operation has no committed source');
        if (pending.kind === 'bootstrap-links') await this.applyBootstrapCrossPopulate(event, pending.numbers);
        else await this.cascadeMergedPr(event, pending.numbers);
        await this.runSubjectOperation(subject, async () => {
          const projection = await this.objectStore.get(subject);
          if (!projection?.pendingFollowUps) return;
          const { pendingFollowUps, ...stable } = projection;
          const remaining = pendingFollowUps.filter(item => item.sourceEventId !== pending.sourceEventId || item.kind !== pending.kind);
          await this.objectStore.save({ ...stable, ...(remaining.length ? { pendingFollowUps: remaining } : {}) });
        });
      });
      if (!ran) return;
    }
  }

  private runSubjectOperation<T>(subjectKey: string, operation: () => Promise<T>): Promise<T> {
    return this.operations.run(subjectKey, operation);
  }

  /**
   * Rebuild projection for a single subject from the event log.
   * Deletes existing projection first, then replays all events.
   */
  async rebuild(subjectKey: string): Promise<void> {
    const canonicalSubjectKey = canonicalizeCommunitySubjectKey(subjectKey);
    const inFlight = this.rebuildInFlight.get(canonicalSubjectKey);
    if (inFlight) return inFlight;

    const operation = this.rebuildSubject(subjectKey);
    this.rebuildInFlight.set(canonicalSubjectKey, operation);
    try {
      await operation;
    } finally {
      if (this.rebuildInFlight.get(canonicalSubjectKey) === operation) {
        this.rebuildInFlight.delete(canonicalSubjectKey);
      }
    }
  }

  private async rebuildSubject(subjectKey: string): Promise<void> {
    try {
      await this.runSubjectOperation(subjectKey, async () => {
        const previous = await this.objectStore.get(subjectKey);
        if (this.effects === 'projection-only') { await this.projectOnly(subjectKey, await this.eventLog.read(subjectKey), previous); return; }
        await this.preserveLegacyLinks(previous);
        const events = await this.eventLog.read(subjectKey);
        await this.objectStore.delete(subjectKey);
        await this.fold(events, 0);
      });
    } finally { await this.drainFollowUps(subjectKey); }
  }

  /** Cross-subject associations have their own journal positions. Rebuilding
   * all subjects needs no pass which applies future links to an old merge. */
  async rebuildAll(): Promise<void> {
    for (const subject of await this.eventLog.listSubjects()) await this.rebuild(subject);
  }
}
