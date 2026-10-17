import { z } from 'zod';

export const COLLECTIVE_NATIVE_ID = 'collective-native';
export const collectivePublicNativeTools = [
  { method: 'collective.context.current', name: 'cat_cafe_collective_current_context',
    description: 'Read the current Collective request and its reply references from this authenticated native origin.',
    schema: z.object({}).strict() },
  { method: 'collective.context.read', name: 'cat_cafe_collective_read_context',
    description: 'Read bounded original Collective context using the contextRef returned by current context.',
    schema: z.object({ contextRef: z.string().min(1).max(256), afterSequence: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }).strict() },
  { method: 'collective.participation.set-interest', name: 'cat_cafe_collective_set_interest',
    description: 'Set this named participant’s listening interest for the current channel; this does not grant Work authority.',
    schema: z.object({ contextRef: z.string().min(1).max(256), state: z.enum(['listen', 'withdraw']) }).strict() },
  { method: 'collective.work.propose', name: 'cat_cafe_collective_propose_work',
    description: 'Propose a public Work from the current authenticated Collective source. This creates a proposal, not an accepted assignment or execution permission.',
    schema: z.object({ contextRef: z.string().min(1).max(256), requestKind: z.string().trim().min(1).max(240).optional(),
      title: z.string().trim().min(1).max(200).optional(), intendedOutcome: z.string().trim().min(1).max(32000).optional() }).strict() },
  { method: 'collective.work.accept', name: 'cat_cafe_collective_accept_work',
    description: 'Accept this current public Collective request using an owner-adopted Work grant and contextRef from current context. Returns accepted_pending_host_admission; it does not start a Host Task or private execution.',
    schema: z.object({ contextRef: z.string().min(1).max(256), grantRef: z.string().trim().min(1).max(240),
      grantRevision: z.number().int().positive(), requestKind: z.string().trim().min(1).max(240),
      title: z.string().trim().min(1).max(200), intendedOutcome: z.string().trim().min(1).max(32000) }).strict() },
  { method: 'collective.work.continue', name: 'cat_cafe_collective_continue_work',
    description: 'Resume or revise a current Work using contextRef/workRef from current context and a current owner-adopted grant. Refresh stale Work references after response loss. Returns accepted_pending_host_admission; private execution remains a separate Host admission.',
    schema: z.object({ contextRef: z.string().min(1).max(256), workRef: z.string().min(1).max(2000), kind: z.enum(['resume', 'revision']),
      grantRef: z.string().trim().min(1).max(240), grantRevision: z.number().int().positive(), requestKind: z.string().trim().min(1).max(240) }).strict() },
  { method: 'collective.reply.submit', name: 'cat_cafe_collective_submit_reply',
    description: 'Return the original reply to the current Collective request. Reuse its returnRef and replyOperationRef after response loss.',
    schema: z.object({ returnRef: z.string().min(1).max(256), replyOperationRef: z.string().min(1).max(256), body: z.string().trim().min(1).max(20000) }).strict() },
] as const;
export const COLLECTIVE_PUBLIC_METHODS = Object.freeze(collectivePublicNativeTools.map(tool => tool.method));
