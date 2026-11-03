import { createHash } from 'node:crypto';
import type { FeatureContext, PluginActionContext, PluginStorageHost } from '@clowder-ai/plugin-sdk';
import { ZodError } from 'zod';
import { ExternalReviewVerdictError } from './business/domains/community/external-review/ExternalReviewVerdictService.js';
import { diagnosticError, type DiagnosticError } from './tracking-diagnostics.js';

export type ReviewVerdictPhase = 'verify_authority' | 'load_projection' | 'read_github' | 'record_verdict' | 'verify_result';
export class ReviewVerdictRefusal extends Error {
  constructor(readonly code: 'native_context_required' | 'review_unassigned' | 'policy_changed') {
    super(code);
  }
}

// Only these package-owned messages cross the native action boundary. Arbitrary
// provider/storage exception text belongs in the redacted private diagnostic.
const refusals = {
  native_context_required: [401, 'A current authenticated native invocation is required.', 'fresh_invocation'],
  invalid_input: [400, 'Review input does not match the declared schema; caller identity and action leases are not inputs.', 'correct_input'],
  not_configured: [409, 'Repository review policy is not configured.', 'check_repository_policy'],
  observe_only: [403, 'Repository policy permits observations only.', 'check_repository_policy'],
  review_unassigned: [409, 'This subject has no assigned private reviewer.', 'check_reviewer_assignment'],
  policy_changed: [409, 'Repository policy changed during this submission.', 'check_repository_policy'],
  wrong_principal: [403, 'The native caller is not the assigned reviewer in this thread.', 'check_reviewer_assignment'],
  subject_terminal: [409, 'The subject is terminal; an active review cannot be registered.', 'retain_delivery_evidence'],
  stale_head: [409, 'The reviewed HEAD is not the current open GitHub HEAD.', 'review_current_head'],
  projection_unavailable: [409, 'The current review projection could not confirm this submission.', 'refresh_projection'],
  head_not_ready: [409, 'The current HEAD is not ready to accept this verdict.', 'inspect_verification_state'],
  invalid_delivery_proof: [400, 'The delivery URL must identify a review or comment on the same PR.', 'correct_input'],
  invalid_pending_reason: [400, 'Pending delivery requires a non-empty reason.', 'correct_input'],
  delivery_regression: [409, 'A delivered verdict cannot return to pending delivery.', 'retry_original_submission'],
  verdict_conflict: [409, 'A different verdict already exists for this HEAD generation.', 'retry_original_submission'],
  provider_read_failed: [503, 'GitHub HEAD verification failed before recording the verdict.', 'retry_same_submission'],
  registration_unavailable: [503, 'Registration could not be confirmed; the result may be unknown.', 'inspect_before_retry'],
} as const;
const recoveryInstructions = {
  fresh_invocation: 'Retry from a fresh authenticated invocation in the original reviewer thread.',
  correct_input: 'Correct the indicated input using the declared tool schema, retaining the existing GitHub delivery URL.',
  check_repository_policy: 'Inspect repository policy and current subject state; do not enable review policy through this submission.',
  check_reviewer_assignment: 'Read the subject assignment and return to the existing responsible reviewer/thread; this call cannot assign a reviewer.',
  retain_delivery_evidence: 'Retain the existing GitHub delivery URL and report the terminal registration refusal; do not reopen the subject or republish the review.',
  review_current_head: 'Read the current GitHub HEAD. Submit only a review that actually covers it; keep an old review as historical evidence.',
  refresh_projection: 'Inspect current subject events/projection and wait for existing collection to observe the reviewed HEAD before retrying the unchanged submission.',
  inspect_verification_state: 'Inspect the current subject verification state; retry only when its existing readiness conditions permit this verdict.',
  retry_original_submission: 'Read current verdict events and retry only the original compatible submission; do not overwrite another verdict.',
  retry_same_submission: 'After GitHub reads recover, retry the unchanged valid submission without posting another GitHub review.',
  inspect_before_retry: 'Read current subject events/projection and the saved diagnostic before retrying the unchanged valid submission; partial writes may already exist.',
} as const;

export interface ReviewVerdictFailure {
  status: number;
  body: {
    error: { code: keyof typeof refusals; message: string; recovery: { action: string; instruction: string } };
    phase: ReviewVerdictPhase;
    outcome: 'not_recorded' | 'unknown';
    subjectKey?: string;
    reviewedHeadSha?: string;
    diagnosticPersisted: boolean;
  };
}
export interface FailureDiagnostic {
  at: number;
  requestKey: string;
  catId: string;
  threadId: string;
  failure: ReviewVerdictFailure;
  error: DiagnosticError;
}
function diagnosticKey(subjectKey: string): string {
  return 'github.review-verdict-failure.v1.' + createHash('sha256').update(subjectKey.toLowerCase()).digest('hex');
}

/** One latest failure per subject, read by exact key; no private-store scan or new ledger. */
export async function readReviewVerdictFailure(storage: PluginStorageHost, subjectKey: string): Promise<FailureDiagnostic | null> {
  return (await storage.get(diagnosticKey(subjectKey)))?.value as FailureDiagnostic ?? null;
}

export async function reviewVerdictFailure(options: {
  error: unknown;
  phase: ReviewVerdictPhase;
  input?: { repoFullName: string; prNumber: number; reviewedHeadSha: string };
  caller?: PluginActionContext;
  storage: PluginStorageHost;
  secrets: FeatureContext['secrets'];
  signal: AbortSignal;
}): Promise<ReviewVerdictFailure> {
  const { error, phase, input, caller } = options;
  const code = error instanceof ExternalReviewVerdictError || error instanceof ReviewVerdictRefusal
    ? error.code : error instanceof ZodError ? 'invalid_input'
      : phase === 'read_github' ? 'provider_read_failed' : 'registration_unavailable';
  const [status, message, recovery] = refusals[code];
  const failure: ReviewVerdictFailure = {
    status, body: {
      error: { code, message, recovery: { action: recovery, instruction: recoveryInstructions[recovery] } }, phase,
      outcome: phase === 'record_verdict' || phase === 'verify_result' ? 'unknown' : 'not_recorded',
      ...(input ? { subjectKey: `pr:${input.repoFullName}#${input.prNumber}`, reviewedHeadSha: input.reviewedHeadSha } : {}),
      diagnosticPersisted: false,
    },
  };
  if (input && caller?.userId && caller.catId && caller.threadId && caller.invocationId && typeof caller.assertCurrent === 'function') {
    try {
      const safeError = await diagnosticError(error, options.secrets);
      options.signal.throwIfAborted();
      await caller.assertCurrent();
      options.signal.throwIfAborted();
      const requestKey = createHash('sha256').update(JSON.stringify([
        caller.invocationId, input,
      ])).digest('hex');
      await options.storage.set(diagnosticKey(failure.body.subjectKey!), {
        at: Date.now(), requestKey, catId: caller.catId, threadId: caller.threadId,
        failure: { ...failure, body: { ...failure.body, diagnosticPersisted: true } }, error: safeError,
      } satisfies FailureDiagnostic);
      failure.body.diagnosticPersisted = true;
    } catch {
      // A diagnostic failure cannot turn a known refusal into another opaque 502.
      // The response explicitly says whether a later exact-subject read can find it.
    }
  }
  return failure;
}
