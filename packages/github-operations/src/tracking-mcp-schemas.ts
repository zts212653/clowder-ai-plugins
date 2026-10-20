import { z } from 'zod';
import { GITHUB_PR_WAIT_PREDICATE_LIMIT, GITHUB_ISSUE_WAIT_PREDICATE_LIMIT } from './business/model/index.js';

const githubWaitAuthorLoginsSchema = z
  .array(z.string().trim().min(1))
  .min(1)
  .max(20)
  .describe('GitHub logins whose comments may wake you, compared case-insensitively. Never empty.');

const githubWaitPredicateInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pr_head_changed') }).strict(),
  z
    .object({
      kind: z.literal('pr_review_result_available'),
      triggerCommentId: z.number().int().positive().optional(),
    })
    .strict(),
  z.object({ kind: z.literal('pr_review_decision_changed') }).strict(),
  z
    .object({
      kind: z.literal('pr_review_thread_changed'),
      reviewThreadIds: z.array(z.string().min(1)).min(1).max(20),
    })
    .strict(),
  z.object({ kind: z.literal('pr_ci_terminal') }).strict(),
  z.object({ kind: z.literal('pr_became_conflicting') }).strict(),
  z.object({ kind: z.literal('pr_conversation_comment_added'), authorLogins: githubWaitAuthorLoginsSchema }).strict(),
  z.object({ kind: z.literal('pr_inline_comment_added'), authorLogins: githubWaitAuthorLoginsSchema }).strict(),
]);

// F280: server-bound typed wait registration — baseline and owner are never caller input.
export const registerPrTrackingInputSchema = {
  registrationId: z.string().trim().min(1).max(200).describe(
    'Generate one unique ID for this registration intent. Reuse the same ID and arguments after an unknown response; use a new ID only to replace the wait intentionally.'),
  repoFullName: z.string().min(1).describe('Repository full name in owner/repo format (e.g. "zts212653/cat-cafe")'),
  prNumber: z.number().int().positive().describe('PR number'),
  when: z
    .array(githubWaitPredicateInputSchema)
    .min(1)
    .max(GITHUB_PR_WAIT_PREDICATE_LIMIT)
    .optional()
    .describe(
      `ADVANCED, and usually omit it. One to ${GITHUB_PR_WAIT_PREDICATE_LIMIT} typed conditions for a precise wait. Omitting this is the normal path: the server then arms every condition the PR raises about itself — review decision, CI terminal and conflict, plus a new HEAD unless you are the PR author (as the author, that push is your own) — AND both comment surfaces, with an audience it derives from your role on that PR. As its author you hear every reply that is not your own, bots included; as a reviewer you hear the PR author's replies, with bots and pure summon commands filtered. Supply this only when you need something narrower or need a condition with its own anchor, such as pr_review_thread_changed; a comment predicate you write here still requires its own explicit \`authorLogins\`. Duplicate kinds, unknown kinds and conditions missing their required parameters are rejected. At most one of \`when\` or \`goal\`.`,
    ),
  goal: z
    .object({
      kind: z.literal('await_reply_from'),
      authorLogins: z.array(z.string().trim().min(1)).min(1).max(20),
    })
    .strict()
    .optional()
    .describe(
      'OPTIONAL narrowing, not a precondition. Comments already wake you by default; add this only to hear from specific people and nobody else. It narrows the audience the server derives from your role on both comment surfaces rather than replacing it: both rules apply, so a comment wakes you only when the derived rule admits it AND you named its author. Naming someone that rule already excludes therefore matches nobody instead of adding them — as the PR author, naming yourself; as a reviewer, naming anyone but the PR author. An empty one is refused rather than widened to everyone. What was actually armed, and what will be filtered, comes back to you in `await.continuation.when` and `notification`. At most one of `when` or `goal`.',
    ),
  nextStep: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .describe(
      'Optional note to yourself, shown with the wake. Omit it and the server writes a deterministic one. Display-only either way: the matcher never reads it, and it decides nothing.',
    ),
  expiresAt: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Optional absolute deadline, Unix ms. Omit it and tracking has no time-based termination. ' +
        'If supplied it must be in the future, it is returned in the registration response, and reaching it ' +
        'ends tracking with an explicit terminal outcome. History is never deleted.',
    ),
  autoRenew: z
    .boolean()
    .optional()
    .describe(
      'Default true: after a match, tracking re-arms automatically with a fresh baseline, so you do not ' +
        'register again. Set false for a single-fire wait that ends after its first match.',
    ),
};

export const registerIssueTrackingInputSchema = {
  registrationId: z.string().trim().min(1).max(200).describe(
    'Generate one unique ID for this registration intent. Reuse the same ID and arguments after an unknown response; use a new ID only to replace the wait intentionally.'),
  repoFullName: z.string().min(1).describe('Repository full name in owner/repo format (e.g. "zts212653/cat-cafe")'),
  issueNumber: z.number().int().positive().describe('Issue number'),
  when: z
    .array(
      z.discriminatedUnion('kind', [
        z
          .object({ kind: z.literal('issue_comment_added'), authorLogins: githubWaitAuthorLoginsSchema.optional() })
          .strict(),
        z.object({ kind: z.literal('issue_author_commented') }).strict(),
      ]),
    )
    .min(1)
    .max(GITHUB_ISSUE_WAIT_PREDICATE_LIMIT)
    .optional()
    .describe(
      `ADVANCED, and usually omit it. One to ${GITHUB_ISSUE_WAIT_PREDICATE_LIMIT} typed issue conditions, evaluated as flat any-of against a server-frozen baseline. Omitting this is the normal path: the server arms every comment on the issue that is not your own.`,
    ),
  nextStep: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe(
      'Optional note to yourself, shown with the wake. Omit it and the server writes a deterministic one. Display-only either way: the matcher never reads it, and it decides nothing.',
    ),
  expiresAt: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Optional absolute deadline, Unix ms. Omit it and tracking has no time-based termination.'),
  autoRenew: z
    .boolean()
    .optional()
    .describe('Default true: tracking re-arms after each match. Set false for a single-fire wait.'),
};

export const unregisterTrackingInputSchema = {
  subjectKey: z
    .string()
    .min(1)
    .describe('Subject key to unregister. Format: "pr:{owner/repo}#{num}" or "issue:{owner/repo}#{num}"'),
};
