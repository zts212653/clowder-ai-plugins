import { z } from 'zod';
import {
  collectiveArtifactCallbackCommandSchema,
  collectiveContextAttachmentSelectionSchema,
  collectiveContextImageSelectionSchema,
  collectiveMessageContentFields,
  requireCollectiveMessageContent,
} from './business/contracts/index.js';

export const collectiveReplySubmitSchema = z
  .object({
    returnRef: z.string().min(1).max(256),
    replyOperationRef: z.string().min(1).max(256),
    ...collectiveMessageContentFields,
    body: z.string().trim().max(20000),
  })
  .strict()
  .superRefine(requireCollectiveMessageContent);

export const collectiveStickerPrepareSchema = z
  .object({
    contextRef: z.string().min(1).max(256),
    stickerId: z.string().min(1).max(80).describe('Stable id from current context stickerCatalog'),
  })
  .strict();

export const collectiveContextReadSchema = z
  .object({
    contextRef: z.string().min(1).max(256).describe('Opaque contextRef returned by current context in this invocation'),
    afterSequence: z.number().int().nonnegative().optional().describe('Exclusive event sequence for a context page'),
    limit: z.number().int().min(1).max(100).optional().describe('Maximum events in a context page; default 30'),
    image: collectiveContextImageSelectionSchema
      .optional()
      .describe('Read actual pixels of this published attachment instead of a context page'),
    attachment: collectiveContextAttachmentSelectionSchema
      .optional()
      .describe(
        'Read supported original text (pass the returned nextOffset as textOffset to continue), explicit-service audio or a sampled video frame; time windows apply to audio/video only',
      ),
  })
  .strict()
  .refine((input) => !(input.image && input.attachment), 'Choose one attachment selector');

export const COLLECTIVE_NATIVE_ID = 'collective-native';
export const collectivePublicNativeTools = [
  {
    method: 'collective.context.current',
    name: 'cat_cafe_collective_current_context',
    description:
      'Read the current authenticated Collective request, including public attachment references and reply handles. Use when: entering a Collective conversation or refreshing its source. NOT for: private Café history or starting private Work. Output: the original public request, contextRef, and reply references; attachment references alone do not deliver image pixels. Inspect images with read context and its image selector.',
    schema: z.object({}).strict(),
  },
  {
    method: 'collective.context.read',
    name: 'cat_cafe_collective_read_context',
    description:
      'Read original public Channel context or the actual content of a published attachment using current contextRef. Use when: catching up, seeing an image/video, reading a supported UTF-8 file or transcribing public audio. NOT for: private staging, another Channel, arbitrary URLs, private Work citations or Work admission. Output: an event page; image={eventId,attachmentId} returns native pixels; attachment={eventId,attachmentId,textOffset?,startSeconds?,durationSeconds?} returns supported text, an explicit current-Host speech transcript, or a native video sample at the requested time with available first-track speech. Continue text with its returned nextOffset as textOffset. Audio defaults to a 30-second window, at most120 seconds; video samples are not frame-accurate Work citations. Truncation and unavailable readers are explicit. Originals remain unchanged. GOTCHA: links/metadata do not prove content was read; inspect the actual result before claiming to have seen or heard it.',
    schema: collectiveContextReadSchema,
  },
  {
    method: 'collective.sticker.prepare',
    name: 'cat_cafe_collective_prepare_sticker',
    description:
      'Prepare an original catalogue sticker for this named participant’s current public reply. Use when: replying with a stickerId from current context stickerCatalog. NOT for: arbitrary file uploads, private Human drafts, changing Work status or publishing by itself. Output: an immutable retained attachment to include in submit reply attachments; the original bytes stay with their content custodian. Repeating preparation for the same reply and sticker returns the same reference.',
    schema: collectiveStickerPrepareSchema,
  },
  {
    method: 'collective.artifact.command',
    name: 'cat_cafe_collective_artifact_command',
    description:
      'Read or propose a response to the shared artifact request in this authenticated Collective source. Humans retain apply authority.',
    schema: collectiveArtifactCallbackCommandSchema,
  },
  {
    method: 'collective.work.suggest-project',
    name: 'cat_cafe_collective_suggest_project_work',
    description:
      'Suggest a Project task or prerequisite from current public context. The suggestion awaits a Human decision and grants no private execution.',
    schema: z
      .object({
        contextRef: z.string().min(1).max(256),
        projectRef: z.string().min(1).max(2000),
        prerequisiteForWorkRef: z.string().min(1).max(2000).optional(),
        title: z.string().trim().min(1).max(200),
        intendedOutcome: z.string().trim().min(1).max(32000),
      })
      .strict(),
  },
  {
    method: 'collective.participation.set-interest',
    name: 'cat_cafe_collective_set_interest',
    description:
      'Set this named participant’s listening interest for the current channel; this does not grant Work authority.',
    schema: z
      .object({
        contextRef: z.string().min(1).max(256),
        state: z.enum(['listen', 'withdraw']),
      })
      .strict(),
  },
  {
    method: 'collective.work.propose',
    name: 'cat_cafe_collective_propose_work',
    description:
      'Propose a public Work from the current authenticated Collective source. This creates a proposal, not an accepted assignment or execution permission.',
    schema: z
      .object({
        contextRef: z.string().min(1).max(256),
        requestKind: z.string().trim().min(1).max(240).optional(),
        title: z.string().trim().min(1).max(200).optional(),
        intendedOutcome: z.string().trim().min(1).max(32000).optional(),
      })
      .strict(),
  },
  {
    method: 'collective.work.accept',
    name: 'cat_cafe_collective_accept_work',
    description:
      'Accept this current public Collective request using an owner-adopted Work grant and contextRef from current context. Returns accepted_pending_host_admission; it does not start a Host Task or private execution.',
    schema: z
      .object({
        contextRef: z.string().min(1).max(256),
        grantRef: z.string().trim().min(1).max(240),
        grantRevision: z.number().int().positive(),
        requestKind: z.string().trim().min(1).max(240),
        title: z.string().trim().min(1).max(200),
        intendedOutcome: z.string().trim().min(1).max(32000),
      })
      .strict(),
  },
  {
    method: 'collective.work.continue',
    name: 'cat_cafe_collective_continue_work',
    description:
      'Resume or revise a current Work using contextRef/workRef from current context and a current owner-adopted grant. Refresh stale Work references after response loss. Returns accepted_pending_host_admission; private execution remains a separate Host admission.',
    schema: z
      .object({
        contextRef: z.string().min(1).max(256),
        workRef: z.string().min(1).max(2000),
        kind: z.enum(['resume', 'revision']),
        grantRef: z.string().trim().min(1).max(240),
        grantRevision: z.number().int().positive(),
        requestKind: z.string().trim().min(1).max(240),
      })
      .strict(),
  },
  {
    method: 'collective.reply.submit',
    name: 'cat_cafe_collective_submit_reply',
    description:
      'Publish this named participant’s original reply to the current Collective request. Use when: returning text, public quotes or applicable rich content with its current returnRef and replyOperationRef. NOT for: private approval callbacks, Work admission or publishing another person’s private uploads. Output: the durable public reply and its original event receipt; a rich-only reply may have an empty body. Reuse the same references and exact content after response loss; changed content conflicts with the original operation.',
    schema: collectiveReplySubmitSchema,
  },
] as const;
export const COLLECTIVE_PUBLIC_METHODS = Object.freeze(collectivePublicNativeTools.map((tool) => tool.method));
