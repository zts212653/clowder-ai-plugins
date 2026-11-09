import { createHash } from 'node:crypto';
import type { PluginStorageHost } from '@clowder-ai/plugin-sdk';
import { z } from 'zod';
import { dotConnectionStateSchema } from './connection-state.js';
import { dotExternalStateSchema, REVOKED_PLUGIN_TOKEN_ERROR, type DotExternalState } from './external-state.js';
export const CONNECTION_KEY = 'dot/connection/v1';
export const EXTERNAL_KEY = 'dot/external/v1';
const ref = z.string().min(1).max(512);
export const dispatchSchema = z.object({
    eventId: z.string().regex(/^dot_evt_[a-f0-9]{64}$/), ownerUserId: ref, threadId: ref, sourceMessageId: ref,
    dispatchInvocationId: ref, attemptId: ref, agentKeyId: ref, occurredAt: z.number(), webhookAcknowledgedAt: z.number().nullable(),
    sourceReadAt: z.number().nullable(), replyMessageId: ref.nullable(), imagePublicationIds: z.array(ref),
    imageReservationIds: z.array(ref).optional(), connectionTest: z.boolean().default(false),
    verificationKey: ref.optional(),
    expectedNonce: z.string().regex(/^[a-f0-9]{16}$/).optional(), sourceRevision: ref.optional(),
    candidateProof: z.object({ candidateId: ref, tokenId: ref, bindingVersion: z.number().int().positive() }).strict().optional(),
    replyDigest: ref.optional(), deliveryId: ref.optional(), deliveryError: z.string().min(1).max(200).nullable().optional(),
}).strict();
export type Dispatch = z.infer<typeof dispatchSchema>;
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const eventId = (attempt: string, thread: string, source: string, execution: string) => `dot_evt_${digest([attempt, thread, source, execution])}`;
export function eventKey(id: string) {
    if (!/^dot_evt_[a-f0-9]{64}$/.test(id))
        throw new Error('dot_event_id_invalid');
    return `dot/dispatch/${id}`;
}
export class DotStore {
    constructor(readonly storage: PluginStorageHost) { }
    async connection() {
        const entry = await this.storage.get(CONNECTION_KEY);
        return entry ? dotConnectionStateSchema.parse(entry.value) : null;
    }
    async dispatch(id: string) {
        const entry = await this.storage.get(eventKey(id));
        return entry ? dispatchSchema.parse(entry.value) : null;
    }
    async external() {
        const entry = await this.storage.get(EXTERNAL_KEY);
        return entry ? dotExternalStateSchema.parse(entry.value) : null;
    }
    /** Mutators are pure: an unrelated writer may require a CAS retry. Never put I/O in change. */
    async update<T>(key: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, change: (value: T | null) => T): Promise<T> {
        for (let attempt = 0; attempt < 8; attempt++) {
            const entry = await this.storage.get(key);
            const next = schema.parse(change(entry ? schema.parse(entry.value) : null));
            if ((await this.storage.compareAndSet(key, entry?.revision ?? null, next)).applied)
                return next;
        }
        throw new Error('dot_state_conflict');
    }
    updateConnection(change: (value: z.infer<typeof dotConnectionStateSchema> | null) => z.infer<typeof dotConnectionStateSchema>) {
        return this.update(CONNECTION_KEY, dotConnectionStateSchema, change);
    }
    updateExternal(change: (value: z.infer<typeof dotExternalStateSchema> | null) => z.infer<typeof dotExternalStateSchema>) {
        const keys = (state: DotExternalState | null) => new Set([
            ...(state?.current?.kind === 'plugin' ? [digest(state.current.token)] : []),
            ...(state?.pending?.issuer === 'plugin' ? [digest(state.pending.token)] : []),
        ]);
        return this.update(EXTERNAL_KEY, dotExternalStateSchema, value => {
            const previousKeys = keys(value);
            const retired = new Set(value?.retiredPluginTokenDigests ?? []);
            const next = change(value);
            const nextKeys = keys(next);
            for (const key of next.retiredPluginTokenDigests ?? []) retired.add(key);
            for (const key of previousKeys) if (!nextKeys.has(key)) retired.add(key);
            for (const key of nextKeys) if (retired.has(key)) throw new Error(REVOKED_PLUGIN_TOKEN_ERROR);
            // Removal and its durable denial history commit in the same CAS, including retries.
            return retired.size ? { ...next, retiredPluginTokenDigests: [...retired] } : next;
        });
    }
    updateDispatch(id: string, change: (value: Dispatch | null) => Dispatch) {
        return this.update(eventKey(id), dispatchSchema, value => {
            const next = change(value);
            if (next.eventId !== id)
                throw new Error('dot_event_identity_mismatch');
            return next;
        });
    }
}
