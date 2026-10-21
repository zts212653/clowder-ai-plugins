import { z } from 'zod';
const identifier = z.string().min(1).max(500);
export const exportedTaskSchema = z.object({ id: identifier, kind: z.enum(['pr_tracking', 'issue_tracking']),
  threadId: identifier, ownerCatId: identifier, userId: identifier.optional(),
  subjectKey: z.string().regex(/^(pr|issue):[a-z0-9_.-]+\/[a-z0-9_.-]+#[1-9]\d*$/),
  title: z.string().max(10000), why: z.string().max(100000), status: z.enum(['todo','doing','blocked','done']),
  createdBy: identifier, createdAt: z.number().nonnegative().safe(), updatedAt: z.number().nonnegative().safe(),
  automationState: z.record(z.unknown()).refine(value => Object.keys(value).every(key =>
    ['ci','conflict','review','issue','closedAt','await','waitOutcome'].includes(key))).optional(), notification: z.unknown().optional(),
}).strict();
export const exportedRepoSchema = z.object({ repo: z.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/),
  guardThreadId: identifier, guardCatId: identifier, reviewMode: z.enum(['observe_only','maintainer_review']),
  cloudReviewPolicy: z.enum(['optional','required']), createdAt: z.number().nonnegative().safe(), updatedAt: z.number().nonnegative().safe() }).strict();
export const exportedReceiptSchema = z.object({ taskId: identifier, outcomeId: identifier.optional(), messageId: identifier.optional(), sourceRef: identifier,
  disposition: z.enum(['delivered','not-delivered','ambiguous']), messageAppended: z.boolean(), wakeAccepted: z.boolean() }).strict();
