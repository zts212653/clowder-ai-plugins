import { z } from 'zod';
import { REVIEW_VERDICT_METHOD, reviewVerdictInput } from './community-review-verdict.js';
import { communityNativeMethods, communityNativeInput, type CommunityNativeMethod } from './community-native-actions.js';
import { GITHUB_PR_WAIT_PREDICATE_LIMIT } from './business/model/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ModuleActionCallOptions } from '@clowder-ai/plugin-sdk';
import { registerPrTrackingInputSchema, registerIssueTrackingInputSchema, unregisterTrackingInputSchema } from './tracking-mcp-schemas.js';

/** The installed plugin owns these handlers. No callback URL or Host GitHub route. */
export interface TrackingMcpHandlers {
  bindMigration?(input: unknown, call: ModuleActionCallOptions): Promise<unknown>;
  reviewVerdict?(input: unknown, call: ModuleActionCallOptions): Promise<unknown>;
  community?(method: CommunityNativeMethod, input: unknown, call: ModuleActionCallOptions): Promise<unknown>;
  registerPr(input: unknown, call: ModuleActionCallOptions): Promise<unknown>;
  registerIssue(input: unknown, call: ModuleActionCallOptions): Promise<unknown>;
  unregister(input: unknown, call: ModuleActionCallOptions): Promise<unknown>;
}

export const TRACKING_ACTION_METHODS = {
  registerPr: 'github.typed-wait.register-pr',
  registerIssue: 'github.typed-wait.register-issue',
  unregister: 'github.typed-wait.unregister',
} as const;

/** Only the transport receives runtime metadata; tool arguments stay unchanged. */
export function createRemoteTrackingMcpServer(client: {
  invoke(method: string, input: unknown, call: ModuleActionCallOptions): Promise<unknown>;
}): McpServer {
  return createTrackingMcpServer({
    bindMigration: (input, call) => client.invoke('github.migration.bind-wait', input, call),
    reviewVerdict: (input, call) => client.invoke(REVIEW_VERDICT_METHOD, input, call),
    community: (method, input, call) => client.invoke(method, input, call),
    registerPr: (input, call) => client.invoke(TRACKING_ACTION_METHODS.registerPr, input, call),
    registerIssue: (input, call) => client.invoke(TRACKING_ACTION_METHODS.registerIssue, input, call),
    unregister: (input, call) => client.invoke(TRACKING_ACTION_METHODS.unregister, input, call),
  });
}

export function createTrackingMcpServer(handlers: TrackingMcpHandlers): McpServer {
  const server = new McpServer({ name: 'clowder-github-tracking', version: '0.1.0' });
  const respond = (handler: TrackingMcpHandlers['registerPr']) => async (input: unknown, call: ModuleActionCallOptions) => {
    try {
      return { content: [{ type: 'text' as const, text: JSON.stringify(await handler(input, call)) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const,
        text: error instanceof Error ? error.message : 'GitHub tracking failed' }] };
    }
  };
  server.tool('cat_cafe_register_pr_tracking',
    'Register continuous tracking of one PR for the current cat and thread. ' +
      'Use when: you want to hear about what happens on a PR — its review decision, CI, conflicts, a new HEAD unless you are the PR author, and the replies people leave on it. Supply the subject and a unique registrationId; reuse that ID and arguments after an unknown response. ' +
      'NOT for: another cat’s responsibility, or a different PR subject. ' +
      'Output: registers a plugin-private notification subscription, never a Host Task or invocation continuation; validates subject/owner, freezes a live GitHub baseline, atomically installs the next generation, and answers with what was armed and which audience was applied (`notification`). Registration history is baseline, never a wake. ' +
      'GOTCHA: For exact-HEAD external PR review, run the Review Entry Mode Classifier before registration: formal instructions containing a no-comment / do-not-comment-on-GitHub directive fail closed; only explicit advisory_read_only may stay private, and advisory must never claim review-complete. ' +
      `GOTCHA: \`repoFullName\` + \`prNumber\` plus a unique registrationId is the normal call — omit \`when\`, \`goal\` and \`nextStep\`. The server then arms every condition the PR raises about itself, plus a new HEAD unless you are the PR author (as the author, that push is your own), AND both comment surfaces, with the audience your role gives you: as the PR author, every reply that is not your own, bots included; as a reviewer with checkable grounds, the PR author's replies with bots and pure summon commands filtered. If it cannot establish identity it delivers every comment flagged rather than filtering on a rule it could not verify — read \`notification.perspective\`. \`goal\` optionally narrows the comment audience to people you name. \`when\` is the advanced path: up to ${GITHUB_PR_WAIT_PREDICATE_LIMIT} flat any-of typed predicates, one per distinct condition in the catalog, where \`pr_conversation_comment_added\` and \`pr_inline_comment_added\` still require a non-empty \`authorLogins\`; there is no omitted-means-anyone form on that path. \`nextStep\` is display-only and never parsed. \`expiresAt\` is optional: omit it for no time-based termination; supply it for a visible deadline. It never deletes task history.`,
    registerPrTrackingInputSchema, respond((input, call) => handlers.registerPr(input, call)));
  server.tool('cat_cafe_register_issue_tracking',
    'Register continuous tracking of one GitHub issue for the current cat and thread. ' +
      'Use when: you want to hear about new comments on an issue. Supply the subject and a unique registrationId; reuse that ID and arguments after an unknown response. ' +
      'NOT for: actor-type guessing, source prose, another cat’s responsibility, or a different issue subject. ' +
      'Output: registers a plugin-private notification subscription, never a Host Task or invocation continuation; validates subject/owner, freezes a live issue baseline, atomically installs the next generation, and answers with what was armed and which audience was applied (`notification`). Registration history is baseline, never a wake. ' +
      'GOTCHA: `repoFullName` + `issueNumber` is the whole normal call — omit `when` and `nextStep`. The server then wakes you on every comment that is not your own. `when` is the advanced path: a bounded typed predicate set for a narrower wait. `nextStep` is display-only and never parsed. `expiresAt` is optional: omit it for no time-based termination; supply it for a visible deadline. It never deletes task history.',
    registerIssueTrackingInputSchema, respond((input, call) => handlers.registerIssue(input, call)));
  server.tool('cat_cafe_unregister_tracking',
    'Cancel the PR or issue subscription for the current authenticated user, cat and thread by subjectKey. ' +
      'Stops automated notifications only for this subscriber and retains its history. Other cats and threads remain subscribed. ' +
      'Output: unregistered reports whether this caller had a subscription; scope is current_user_cat_thread. It never means all subscribers stopped. ' +
      'Format: "pr:{owner/repo}#{num}" or "issue:{owner/repo}#{num}".',
    unregisterTrackingInputSchema, respond((input, call) => handlers.unregister(input, call)));
  if (handlers.bindMigration) server.tool('github_bind_migrated_wait',
    'Use when an owner-approved GitHub import is committing and requests this existing Task binding. Call from its original authenticated cat and thread with the exact plan digest and Task ID. Writes a Host wait projection while preserving its generation and baseline. Not for fresh registration, owner changes, expired waits, ambiguous old deliveries or releasing collectors. Output: bound with original generation while collection stays held; changed bindings or missing strict authentication fail. A lost response may be retried from a fresh authenticated turn using the same Task and digest.',
    { taskId: z.string().min(1).max(500), expectedDigest: z.string().regex(/^[a-f0-9]{64}$/) },
    respond((input, call) => handlers.bindMigration!(input, call)));
  if (handlers.reviewVerdict) server.tool('github_record_external_review_verdict',
    'Submit a verdict for the assigned exact PR HEAD under the current native invocation and action lease. ' +
    'Use the exact lease generation and review/comment URL, or an explicit pending_delivery reason. ' +
    'Persists the submission before Host completion verification. pending_verification is NOT review completion; ' +
    'retry the same submission from a fresh authenticated invocation after the missing evidence is available. ' +
    'No caller identity, timestamp or verifier selection is accepted. Does not publish to GitHub.',
    reviewVerdictInput.shape, respond((input, call) => handlers.reviewVerdict!(input, call)));
  if (handlers.community) for (const method of communityNativeMethods) {
    server.tool(method.replaceAll('.', '_').replaceAll('-', '_'),
      `Submit Community ${method.slice('github.community.'.length)} through the authenticated native callback. ` +
      'Use the existing case ID and callback business payload; await-external uses a canonical subject key instead. ' +
      'Not for owner decisions, HTTP forwarding, lease completion or overriding another case owner. ' +
      'The Host supplies current cat/thread/user/invocation separately; payload identity cannot grant authority. ' +
      'Returns the route status/body; refusal is an error and must not be treated as success.',
      communityNativeInput.shape, async (input, call) => {
        try {
          const result = await handlers.community!(method, input, call);
          const failed = !!result && typeof result === 'object' && 'status' in result && typeof result.status === 'number' && result.status >= 400;
          return { ...(failed ? { isError: true } : {}), content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        } catch (error) {
          return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Community callback failed' }] };
        }
      });
  }
  return server;
}
