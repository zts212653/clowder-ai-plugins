import { createHash } from 'node:crypto';
import type { PluginStorageHost } from '@clowder-ai/plugin-sdk';
import { z } from 'zod';
import { dotConnectionStateSchema } from './connection-state.js';
export const CONNECTION_KEY = 'dot/connection/v1';
const ref = z.string().min(1).max(512);
export const dispatchSchema = z.object({
    eventId: z.string().regex(/^dot_evt_[a-f0-9]{64}$/), ownerUserId: ref, threadId: ref, sourceMessageId: ref,
    dispatchInvocationId: ref, attemptId: ref, agentKeyId: ref, occurredAt: z.number(), webhookAcknowledgedAt: z.number().nullable(),
    sourceReadAt: z.number().nullable(), replyMessageId: ref.nullable(), imagePublicationIds: z.array(ref),
    imageReservationIds: z.array(ref).optional(), connectionTest: z.boolean().default(false),
    expectedNonce: z.string().regex(/^[a-f0-9]{16}$/).optional(), sourceRevision: ref.optional(),
    replyDigest: ref.optional(), deliveryId: ref.optional(),
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
    updateDispatch(id: string, change: (value: Dispatch | null) => Dispatch) {
        return this.update(eventKey(id), dispatchSchema, value => {
            const next = change(value);
            if (next.eventId !== id)
                throw new Error('dot_event_identity_mismatch');
            return next;
        });
    }
}
