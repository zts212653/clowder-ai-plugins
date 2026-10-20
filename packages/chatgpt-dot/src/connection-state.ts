import { z } from 'zod';

export const DOT_PLUGIN_ID = 'official.chatgpt-dot';
const ref = z.string().min(1).max(512);

export const dotSubscriptionSchema = z
  .object({
    id: ref,
    url: z.string().url().max(2048),
    secret: z.string().max(256),
    expiresAt: z.number().nullable(),
    verifiedAt: z.number(),
    previousSecret: z.string().max(256).nullable().default(null),
    rotationUntil: z.number().nullable().default(null),
  })
  .strict();

export const dotConnectionStateSchema = z
  .object({
    v: z.literal(1),
    revision: z.number().int().positive(),
    ownerUserId: ref,
    pluginInstanceId: ref,
    agentKeyId: ref,
    credentialSecret: z.string().length(64),
    attemptId: ref,
    pairingCode: z.string().min(16).max(128),
    pairingExpiresAt: z.number(),
    pairedAt: z.number().nullable(),
    pairedCallbackUrl: z.string().url().max(2048).nullable().optional(),
    subscription: dotSubscriptionSchema.nullable(),
    lastSourceReadAt: z.number().nullable(),
    lastReplyAt: z.number().nullable(),
    lastImageAt: z.number().nullable(),
    revokedAt: z.number().nullable(),
    // Decode and retire the old per-cat setting without invalidating paired records.
    allowedCatIds: z.array(ref).max(50).optional(),
    testEventIds: z.array(ref).max(2).default([]),
  })
  .strict()
  .transform(({ allowedCatIds: _retired, ...state }) => state);

export type DotConnectionState = z.infer<typeof dotConnectionStateSchema>;
export type DotSubscription = z.infer<typeof dotSubscriptionSchema>;

