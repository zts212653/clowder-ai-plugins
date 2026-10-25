import { z } from 'zod';
import { collectiveArtifactCallbackCommandSchema, collectiveContextImageSelectionSchema } from './business/contracts/index.js';

export const collectiveContextReadSchema = z.object({
  contextRef: z.string().min(1).max(256).describe('Opaque contextRef returned by current context in this invocation'),
  afterSequence: z.number().int().nonnegative().optional().describe('Exclusive event sequence for a context page'),
  limit: z.number().int().min(1).max(100).optional().describe('Maximum events in a context page; default 30'),
  image: collectiveContextImageSelectionSchema.optional().describe('Read actual pixels of this published attachment instead of a context page'),
}).strict();

export const COLLECTIVE_NATIVE_ID = 'collective-native';
export const collectivePublicNativeTools = [
  { method: 'collective.context.current', name: 'cat_cafe_collective_current_context',
    description: 'Read the current authenticated Collective request, including public attachment references and reply handles. Use when: entering a Collective conversation or refreshing its source. NOT for: private Café history or starting private Work. Output: the original public request, contextRef, and reply references; attachment references alone do not deliver image pixels. Inspect images with read context and its image selector.',
    schema: z.object({}).strict() },
  { method: 'collective.context.read', name: 'cat_cafe_collective_read_context',
    description: 'Read original public Channel context or inspect a published image with the current contextRef. Use when: catching up on this conversation or seeing what an attached picture contains. NOT for: private uploads, another Channel, arbitrary URLs or Work admission. Output: a bounded event page, or a native image block plus its original digest when image={eventId,attachmentId} is supplied. Large images use a bounded view and animations show the first frame; original bytes remain unchanged. GOTCHA: image links and attachment metadata are not pixels; use the image selector before claiming to have seen a picture.',
    schema: collectiveContextReadSchema },
  { method: 'collective.artifact.command', name: 'cat_cafe_collective_artifact_command',
    description: 'Read or propose a response to the shared artifact request in this authenticated Collective source. Humans retain apply authority.',
    schema: collectiveArtifactCallbackCommandSchema },
  { method: 'collective.work.suggest-project', name: 'cat_cafe_collective_suggest_project_work',
    description: 'Suggest a Project task or prerequisite from current public context. The suggestion awaits a Human decision and grants no private execution.',
    schema: z.object({contextRef: z.string().min(1).max(256), projectRef: z.string().min(1).max(2000),
      prerequisiteForWorkRef: z.string().min(1).max(2000).optional(), title: z.string().trim().min(1).max(200),
      intendedOutcome: z.string().trim().min(1).max(32000)}).strict() },
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
