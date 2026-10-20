import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ModulePluginSettingsHost, PluginHostActionContext } from '@clowder-ai/plugin-sdk';
import type { DotConnectionState } from './connection-state.js';
import { DotStore, digest } from './store.js';
import { verifyDotWebhook, type DotWebhookSend } from './dot-webhook.js';
export const equalSecret = (a: string, b: string) => {
    const left = Buffer.from(a), right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
};
export class DotConnection {
    readonly store: DotStore;
    constructor(readonly host: ModulePluginSettingsHost, readonly send: DotWebhookSend, readonly signal: AbortSignal, readonly now = Date.now) {
        this.store = new DotStore(host.storage);
    }
    assertLive() { this.signal.throwIfAborted(); }
    async owner(context?: PluginHostActionContext) {
        this.assertLive();
        if (!context || !['owner-operation', 'owner-http-request'].includes(context.kind) || context.pluginInstanceId !== this.host.pluginInstanceId || !context.userId)
            throw new Error('dot_owner_required');
        context.signal.throwIfAborted();
        await context.assertCurrent();
        this.assertLive();
        const state = await this.store.connection();
        if (state && state.ownerUserId !== context.userId)
            throw new Error('dot_owner_mismatch');
        return context.userId;
    }
    async authenticate(secret: string) {
        this.assertLive();
        const state = await this.store.connection();
        this.assertLive();
        if (!state || state.revokedAt !== null || state.pluginInstanceId !== this.host.pluginInstanceId || !equalSecret(secret, state.credentialSecret))
            throw new Error('dot_credential_rejected');
        return state;
    }
    async ready(secret: string) {
        const state = await this.authenticate(secret);
        if (state.pairedAt === null || !state.subscription || state.subscription.expiresAt !== null && state.subscription.expiresAt <= this.now())
            throw new Error('dot_subscription_required');
        return state;
    }
    async begin(context: PluginHostActionContext | undefined, reconnect = false) {
        const owner = await this.owner(context);
        const configured = await this.host.secrets.get('dotCredential');
        if (configured !== undefined && !/^[a-f0-9]{64}$/.test(configured))
            throw new Error('dot_invalid_credential');
        const state = await this.store.updateConnection(previous => {
            this.assertLive();
            if (previous && previous.ownerUserId !== owner)
                throw new Error('dot_owner_mismatch');
            if (!reconnect && previous?.revokedAt === null && previous.pluginInstanceId === this.host.pluginInstanceId && (previous.pairedAt !== null || previous.pairingExpiresAt > this.now()))
                return previous;
            return { v: 1, revision: (previous?.revision ?? 0) + 1, ownerUserId: owner, pluginInstanceId: this.host.pluginInstanceId,
                agentKeyId: `plugin:${randomUUID()}`, credentialSecret: configured ?? randomBytes(32).toString('hex'), attemptId: randomUUID(),
                pairingCode: randomBytes(16).toString('hex'), pairingExpiresAt: this.now() + 30 * 60000, pairedAt: null, pairedCallbackUrl: null,
                subscription: null, lastSourceReadAt: null, lastReplyAt: null, lastImageAt: null, revokedAt: null, testEventIds: [] };
        });
        return { ...this.project(state), credentialSecret: state.credentialSecret, pairingCode: state.pairingCode,
            instructions: `启用本插件后，订阅 dot.summoned，attempt_id=${state.attemptId}，pairing_code=${state.pairingCode}。每次先读取原消息，再在原对话回复。` };
    }
    async subscribe(secret: string, input: {
        attemptId: string;
        pairingCode: string;
        url: string;
        secret: string;
        ttlMs?: number | null;
    }) {
        const state = await this.authenticate(secret);
        if (state.attemptId !== input.attemptId)
            throw new Error('dot_attempt_mismatch');
        const pinned = state.pairedCallbackUrl ?? state.subscription?.url;
        if (pinned && pinned !== input.url)
            throw new Error('dot_repair_required');
        if (!equalSecret(input.pairingCode, state.pairingCode) || state.pairedAt === null && state.pairingExpiresAt <= this.now())
            throw new Error('dot_pairing_expired_or_mismatched');
        const ttl = input.ttlMs === undefined || input.ttlMs === null ? null : Math.min(input.ttlMs, 7 * 24 * 60 * 60000);
        if (ttl !== null && (!Number.isSafeInteger(ttl) || ttl <= 0))
            throw new Error('dot_invalid_subscription_ttl');
        const id = `dot_${digest([state.ownerUserId, state.agentKeyId, state.attemptId, input.url])}`;
        await verifyDotWebhook(input.url, id, input.secret, this.send, this.signal);
        this.assertLive();
        await this.authenticate(secret);
        const expiresAt = ttl === null ? null : this.now() + ttl;
        await this.store.updateConnection(current => {
            this.assertLive();
            if (!current || current.revision !== state.revision || current.revokedAt !== null)
                throw new Error('dot_stale_connection');
            const prior = current.subscription;
            return { ...current, revision: current.revision + 1, pairedAt: this.now(), pairedCallbackUrl: input.url, subscription: { id, url: input.url, secret: input.secret, expiresAt, verifiedAt: this.now(),
                    previousSecret: prior && prior.secret !== input.secret ? prior.secret : prior?.previousSecret ?? null,
                    rotationUntil: prior && prior.secret !== input.secret ? this.now() + 5 * 60000 : prior?.rotationUntil ?? null } };
        });
        return { id, refreshBefore: expiresAt === null ? null : new Date(expiresAt).toISOString(), cursor: null, truncated: false };
    }
    async unsubscribe(secret: string, input: {
        attemptId: string;
        pairingCode: string;
        url: string;
    }) {
        const state = await this.authenticate(secret);
        if (state.attemptId !== input.attemptId || !equalSecret(state.pairingCode, input.pairingCode) || state.subscription && state.subscription.url !== input.url)
            throw new Error('dot_subscription_mismatch');
        await this.store.updateConnection(current => {
            this.assertLive();
            if (!current || current.revision !== state.revision)
                throw new Error('dot_stale_connection');
            return { ...current, revision: current.revision + 1, pairedCallbackUrl: current.pairedCallbackUrl ?? current.subscription?.url ?? null, pairedAt: null, subscription: null };
        });
        return {};
    }
    async disconnect(context?: PluginHostActionContext) {
        await this.owner(context);
        await this.store.updateConnection(state => {
            this.assertLive();
            if (!state)
                throw new Error('dot_connection_missing');
            return { ...state, revision: state.revision + 1, revokedAt: this.now() };
        });
        return {};
    }
    async evidence(state: DotConnectionState, kind: 'read' | 'reply' | 'image') {
        await this.authenticate(state.credentialSecret);
        await this.store.updateConnection(current => {
            this.assertLive();
            if (!current || current.attemptId !== state.attemptId || current.revokedAt !== null)
                throw new Error('dot_stale_connection');
            const field = kind === 'read' ? 'lastSourceReadAt' : kind === 'reply' ? 'lastReplyAt' : 'lastImageAt';
            return { ...current, revision: current.revision + 1, [field]: this.now() };
        });
    }
    project(state: DotConnectionState | null) {
        const active = state?.revokedAt === null && state.pluginInstanceId === this.host.pluginInstanceId;
        return { pluginInstanceId: this.host.pluginInstanceId, attemptId: state?.attemptId ?? null, revision: state?.revision ?? null,
            paired: !!active && state?.pairedAt !== null, revoked: !!state && !active,
            subscription: !state?.subscription ? 'absent' : active && (state.subscription.expiresAt === null || state.subscription.expiresAt > this.now()) ? 'active' : 'expired',
            sourceReadAt: state?.lastSourceReadAt ?? null, replyAt: state?.lastReplyAt ?? null, imageAt: state?.lastImageAt ?? null,
            pairingExpiresAt: state?.pairingExpiresAt ?? null };
    }
}
