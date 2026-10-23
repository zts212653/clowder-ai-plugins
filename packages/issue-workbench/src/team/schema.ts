import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { TeamIssue } from './types.js';

export const repository = z.string().max(200).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  .refine(value => value.split('/').every(segment => segment !== '.' && segment !== '..'), 'Repository must not contain path traversal')
  .transform(value => value.toLowerCase());
export const login = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/).transform(value => value.toLowerCase());
/** Accept an organization slug or its github.com profile URL, never an arbitrary endpoint. */
export const organization = z.string().trim().max(200).transform(value => {
  const url = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/?$/i.exec(value);
  return url ? url[1] : value;
}).pipe(z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/,
  '请填写 GitHub Organization 名称或组织链接，例如 https://github.com/meow-club')
  .transform(value => value.toLowerCase()));
export const issueInput = z.object({ repo: repository, number: z.number().int().positive() }).strict();
export const idInput = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const analysisSchema = z.object({
  category: z.string().trim().min(1).max(80),
  score: z.number().int().min(1).max(10).nullable(),
  reason: z.string().trim().min(1).max(1000),
  evidence: z.string().trim().min(1).max(1200),
  blocksRuntime: z.boolean(),
  workaround: z.string().max(1000),
}).strict();
export const rulesSchema = z.array(z.object({
  login,
  categories: z.array(z.string().min(1).max(80)).max(50),
  features: z.array(z.string().regex(/^F\d+$/)).max(100),
}).strict()).max(100);
export const dispatchSchema = z.object({
  schema: z.literal('issue-workbench.dispatch.v1'), delivery: z.literal('invitation').optional(), id: idInput.shape.id,
  issueId: z.string().min(1), assignee: login,
  score: z.number().int().min(1).max(10).nullable(),
  reason: z.string().max(1000), sourceVersion: idInput.shape.id,
  acceptanceSuggestedFor: login.optional(),
}).strict();
export const receiptSchema = z.object({
  schema: z.literal('issue-workbench.receipt.v1'), id: idInput.shape.id,
  issueId: z.string().min(1), assignmentId: z.string().min(1).max(200), login,
  status: z.enum(['accepted', 'working', 'blocked', 'ready']),
  summary: z.string().trim().min(1).max(1000),
  evidenceUrls: z.array(z.string().url().max(500).refine(value => {
    const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password;
  }, 'Use GitHub evidence links')).max(10),
}).strict();
export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const issueVersion = (issue: TeamIssue) => hash([issue.id, issue.title, issue.body, issue.state, [...issue.labels].sort(), issue.author ?? null]);
export const features = (issue: TeamIssue) => [...new Set(issue.labels.flatMap(label => {
  const match = /^feature:(F\d+)$/i.exec(label); return match ? [match[1].toUpperCase()] : [];
}))].sort();
