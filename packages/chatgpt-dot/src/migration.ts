import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ModulePluginSettingsHost, PluginHostActionContext } from '@clowder-ai/plugin-sdk';
import { dotConnectionStateSchema } from './connection-state.js';
import { DotStore, CONNECTION_KEY, dispatchSchema, eventKey, digest } from './store.js';
import { imageSchema, validatePng } from './runtime.js';
import { retainImageFile } from './image-file.js';
import { fenceAsyncPort } from './operation-fence.js';
export const legacyImportSchema = z.object({
    version: z.literal(1), ownerUserId: z.string().min(1), sourceInstanceId: z.string().min(1),
    connection: dotConnectionStateSchema.optional(), dispatches: z.array(dispatchSchema).max(100).default([]),
    images: z.array(z.object({ metadata: imageSchema, png_base64: z.string().max(13981016) }).strict()).max(8).default([]),
}).strict();
export type LegacyImportBatch = z.infer<typeof legacyImportSchema>;
/** Explicit owner-bound relocation. Inputs are records/bytes, never server paths. No source is deleted. */
export async function importLegacyBatch(host: ModulePluginSettingsHost, raw: unknown, context?: PluginHostActionContext) {
    const input = legacyImportSchema.parse(raw);
    if (!context || context.pluginInstanceId !== host.pluginInstanceId || context.userId !== input.ownerUserId || context.kind !== 'owner-operation')
        throw new Error('dot_owner_required');
    const authority = context;
    const assertCurrent = async () => {
        authority.signal.throwIfAborted();
        await authority.assertCurrent();
        authority.signal.throwIfAborted();
    };
    const storage = fenceAsyncPort(host.storage, assertCurrent);
    // Storage survives uninstall; completion belongs to both the batch and its target installation.
    // Retain legacy unscoped receipts as history, but never use them as current completion evidence.
    const batchDigest = digest(input), receiptKey = `dot/migration/receipt/${digest([host.pluginInstanceId, batchDigest])}`;
    const receipt = await storage.get(receiptKey);
    if (receipt) {
        const value = receipt.value as Record<string, unknown>;
        if (!value || value.batchDigest !== batchDigest || value.ownerUserId !== input.ownerUserId ||
            value.sourceInstanceId !== input.sourceInstanceId || value.pluginInstanceId !== host.pluginInstanceId)
            throw new Error('dot_migration_receipt_mismatch');
        return { ...receipt.value as object, duplicate: true };
    }
    const store = new DotStore(storage), prior = await store.connection();
    if (prior && prior.ownerUserId !== input.ownerUserId)
        throw new Error('dot_owner_mismatch');
    let inserted = 0, alreadyPresent = 0;
    if (input.connection) {
        if (input.connection.ownerUserId !== input.ownerUserId || input.connection.pluginInstanceId !== input.sourceInstanceId)
            throw new Error('dot_migration_source_mismatch');
        const next = { ...input.connection, pluginInstanceId: host.pluginInstanceId };
        let retained = false;
        for (let retry = 0; retry < 8; retry++) {
            const entry = await storage.get(CONNECTION_KEY);
            if (!entry) {
                if (!(await storage.compareAndSet(CONNECTION_KEY, null, next)).applied)
                    continue;
                inserted++;
            }
            else {
                const current = dotConnectionStateSchema.parse(entry.value);
                if (current.ownerUserId !== next.ownerUserId || current.attemptId !== next.attemptId || current.credentialSecret !== next.credentialSecret || current.agentKeyId !== next.agentKeyId || current.pairingCode !== next.pairingCode)
                    throw new Error('dot_migration_conflict');
                // Only the current Host owner-operation fence may relocate retained state after
                // reinstall. Recheck through fenced CAS; never copy stale runtime or revocation data.
                const revokedAt = current.revokedAt ?? next.revokedAt;
                if ((current.pluginInstanceId !== host.pluginInstanceId || current.revokedAt !== revokedAt) &&
                    !(await storage.compareAndSet(CONNECTION_KEY, entry.revision, { ...current, pluginInstanceId: host.pluginInstanceId, revokedAt })).applied)
                    continue;
                alreadyPresent++;
            }
            retained = true;
            break;
        }
        if (!retained)
            throw new Error('dot_state_conflict');
    }
    const state = await store.connection();
    if (!state || state.ownerUserId !== input.ownerUserId || state.pluginInstanceId !== host.pluginInstanceId)
        throw new Error('dot_migration_connection_required');
    async function retain(key: string, value: unknown, kind: 'dispatch' | 'image') {
        for (let retry = 0; retry < 8; retry++) {
            const prior = await storage.get(key);
            if (!prior) {
                if ((await storage.compareAndSet(key, null, value)).applied) {
                    inserted++;
                    return;
                }
                continue;
            }
            let next: unknown;
            if (kind === 'dispatch') {
                const current = dispatchSchema.parse(prior.value), incoming = dispatchSchema.parse(value);
                const immutable = ['eventId', 'ownerUserId', 'threadId', 'sourceMessageId', 'dispatchInvocationId', 'attemptId', 'agentKeyId', 'occurredAt', 'connectionTest'] as const;
                if (immutable.some(field => current[field] !== incoming[field]) ||
                    incoming.sourceRevision && current.sourceRevision && incoming.sourceRevision !== current.sourceRevision ||
                    incoming.expectedNonce && current.expectedNonce && incoming.expectedNonce !== current.expectedNonce ||
                    incoming.replyMessageId && current.replyMessageId && incoming.replyMessageId !== current.replyMessageId)
                    throw new Error('dot_migration_conflict');
                next = { ...incoming, ...current,
                    webhookAcknowledgedAt: current.webhookAcknowledgedAt ?? incoming.webhookAcknowledgedAt,
                    sourceReadAt: current.sourceReadAt ?? incoming.sourceReadAt,
                    replyMessageId: current.replyMessageId ?? incoming.replyMessageId,
                    imagePublicationIds: [...new Set([...current.imagePublicationIds, ...incoming.imagePublicationIds])],
                    ...(current.imageReservationIds || incoming.imageReservationIds ? { imageReservationIds: [...new Set([...current.imageReservationIds ?? [], ...incoming.imageReservationIds ?? []])] } : {}) };
            }
            else {
                const current = imageSchema.parse(prior.value), incoming = imageSchema.parse(value);
                const { messageId: currentMessage, ...currentIdentity } = current, { messageId: incomingMessage, ...incomingIdentity } = incoming;
                if (digest(currentIdentity) !== digest(incomingIdentity) || currentMessage && incomingMessage && currentMessage !== incomingMessage)
                    throw new Error('dot_migration_conflict');
                next = { ...current, messageId: currentMessage ?? incomingMessage };
            }
            if (digest(next) === digest(prior.value)) {
                alreadyPresent++;
                return;
            }
            if ((await storage.compareAndSet(key, prior.revision, next)).applied) {
                alreadyPresent++;
                return;
            }
        }
        throw new Error('dot_state_conflict');
    }
    for (const record of input.dispatches) {
        // Older pairing attempts remain historical evidence, never active credentials.
        if (record.ownerUserId !== input.ownerUserId)
            throw new Error('dot_migration_source_mismatch');
        await retain(eventKey(record.eventId), record, 'dispatch');
    }
    for (const image of input.images) {
        const asset = image.metadata;
        if (asset.ownerUserId !== input.ownerUserId)
            throw new Error('dot_migration_source_mismatch');
        const dispatch = await store.dispatch(asset.eventId);
        if (!dispatch || dispatch.threadId !== asset.threadId)
            throw new Error('dot_migration_source_mismatch');
        const checked = await validatePng(image.png_base64), bytes = checked.bytes;
        if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256 || bytes.length !== asset.byteSize || checked.width !== asset.width || checked.height !== asset.height)
            throw new Error('dot_migration_image_mismatch');
        await assertCurrent();
        await retainImageFile(host.dataPath, asset.id, bytes, assertCurrent, 'dot_migration_conflict');
        await retain(`dot/image/${asset.id}`, asset, 'image');
    }
    const result = { version: 1, batchDigest, ownerUserId: input.ownerUserId, sourceInstanceId: input.sourceInstanceId,
        pluginInstanceId: host.pluginInstanceId, connection: input.connection ? 1 : 0, dispatches: input.dispatches.length, images: input.images.length,
        inserted, alreadyPresent, sourceDeleted: false, importedAt: Date.now() };
    if ((await storage.compareAndSet(receiptKey, null, result)).applied)
        return result;
    const raced = await storage.get(receiptKey);
    if (!raced)
        throw new Error('dot_state_conflict');
    return { ...raced.value as object, duplicate: true };
}
