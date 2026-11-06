import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type {
	ModulePluginSettingsHost,
	PluginHostActionContext,
} from "@clowder-ai/plugin-sdk";
import type { DotConnectionState } from "./connection-state.js";
import {
	credentialLive,
	currentCredentialSchema,
	type DotExternalState,
	type PendingCredential,
	type VerifiedExternalCredential,
} from "./external-state.js";
import { DotStore, digest } from "./store.js";
import { verifyDotWebhook, type DotWebhookSend } from "./dot-webhook.js";
import { fenceAsyncPort } from "./operation-fence.js";
export const equalSecret = (a: string, b: string) => {
	const left = Buffer.from(a),
		right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
};
export type DotSettingsHost = ModulePluginSettingsHost & {
	readonly external: {
		readonly endpoint: string;
		readonly token: string;
		readonly shared?: {
			status(): Promise<SharedConnectionView>;
			prepare(input: {
				readonly confirmationActionId: string;
			}): Promise<SharedProposalView>;
			bind(proposalRef: string): Promise<SharedConnectionView>;
			unbind(expectedBindingRevision: number): Promise<SharedConnectionView>;
		};
	};
};
export type ExternalOperation =
	| "discovery"
	| "pairing-subscribe"
	| "pairing-unsubscribe"
	| "verification-read"
	| "verification-reply"
	| "business"
	| "read"
	| "reply"
	| "publish-image"
	| "ask";
export const DOT_EXTERNAL_CAPABILITY_ID = "dot-mcp";
export interface SharedConnectionView {
	readonly deployment:
		| {
				readonly state: "configured";
				readonly endpoint: string;
				readonly principal: string;
		  }
		| { readonly state: "missing-endpoint"; readonly principal: string }
		| { readonly state: "missing-principal" };
	readonly binding: {
		readonly state:
			| "unbound"
			| "active"
			| "needs-confirmation"
			| "revoked"
			| "occupied";
		readonly revision: number;
		readonly scope: { readonly tools: number; readonly events: number };
	};
}
export interface SharedProposalView {
	readonly proposalRef: string;
	readonly expiresAt: number;
	readonly presentation: {
		readonly key: string;
		readonly label: string;
		readonly detail: string;
		readonly actions: readonly {
			readonly action: string;
			readonly label: string;
			readonly confirm: string;
			readonly input: { readonly proposalRef: string };
		}[];
	};
	readonly connection: SharedConnectionView;
}
type BoundConnection = DotConnectionState & {
	bindingAuthority?: {
		key: string;
		candidateId?: string;
		tokenId?: string;
		version?: number;
		eventId?: string;
	};
};
export class DotConnection {
	readonly store: DotStore;
	private readonly operations = new AsyncLocalStorage<
		PluginHostActionContext | undefined
	>();
	constructor(
		readonly host: DotSettingsHost,
		readonly send: DotWebhookSend,
		readonly signal: AbortSignal,
		readonly now = Date.now,
	) {
		this.store = new DotStore(
			fenceAsyncPort(host.storage, () => this.assertCurrent()),
		);
	}
	within<T>(
		context: PluginHostActionContext | undefined,
		run: () => Promise<T>,
	): Promise<T> {
		return this.operations.run(context, run);
	}
	assertLive() {
		this.signal.throwIfAborted();
		this.operations.getStore()?.signal.throwIfAborted();
	}
	private async checkCurrent(context?: PluginHostActionContext) {
		this.signal.throwIfAborted();
		context?.signal.throwIfAborted();
		await context?.assertCurrent();
		this.signal.throwIfAborted();
		context?.signal.throwIfAborted();
	}
	assertCurrent() {
		return this.checkCurrent(this.operations.getStore());
	}
	async externalState() {
		const existing = await this.store.external();
		if (existing) return existing;
		const connection = await this.store.connection();
		return this.store.updateExternal(
			(current) =>
				current ?? {
					v: 1,
					revision: 1,
					current:
						this.host.external.token || connection?.credentialSecret
							? {
									kind: "legacy",
									recordRef: this.host.external.token
										? "host.external"
										: "connection.credentialSecret",
								}
							: null,
					pending: null,
					// Host external.endpoint is the internal forwarding coordinate. It may
					// deliberately be relative and is never proof that the installation
					// has a public URL. Dot records a public endpoint only after the owner
					// supplies a validated HTTPS template or starts its temporary runner.
					endpoint: { mode: "absent" },
				},
		);
	}
	async issuePending(
		context: PluginHostActionContext | undefined,
		ttlSeconds: number,
	) {
		await this.owner(context);
		if (
			!Number.isSafeInteger(ttlSeconds) ||
			ttlSeconds <= 0 ||
			ttlSeconds > 180 * 24 * 60 * 60
		)
			throw new Error("dot_external_ttl_invalid");
		const capability = this.host.capability;
		if (!capability) throw new Error("dot_external_capability_unavailable");
		const issued = await capability.issueExternal({
			capabilityId: DOT_EXTERNAL_CAPABILITY_ID,
			ttlSeconds,
		});
		await this.assertCurrent();
		return { state: await this.stagePending(issued), issued };
	}
	async issuePluginPending(
		context: PluginHostActionContext | undefined,
		ttlSeconds?: number,
	) {
		await this.owner(context);
		const captured = await this.externalState();
		if (
			ttlSeconds !== undefined &&
			(!Number.isSafeInteger(ttlSeconds) ||
				ttlSeconds <= 0 ||
				ttlSeconds > 86400)
		)
			throw new Error("dot_external_ttl_invalid");
		const stored = ttlSeconds === undefined
			? await this.host.secrets.get("externalMcpToken")
			: undefined;
		const configured = stored === "" ? undefined : stored;
		if (configured !== undefined && !/^[A-Za-z0-9_-]{43,256}$/.test(configured))
			throw new Error("dot_mcp_token_invalid");
		const token = configured ?? randomBytes(32).toString("base64url");
		const previous = captured;
		if (
			previous.current?.kind === "plugin" &&
			equalSecret(previous.current.token, token)
		)
			throw new Error("dot_mcp_token_unchanged");
		const issued = {
			token,
			tokenId: randomUUID(),
			issuedAt: Math.floor(this.now() / 1000),
			expiresAt:
				ttlSeconds === undefined
					? null
					: Math.floor(this.now() / 1000) + ttlSeconds,
			refreshRecommendedAt: null,
		};
		await this.assertCurrent();
		return { state: await this.stagePending(issued, "plugin", captured.revision), issued };
	}
	private async stagePending(
		issued: Pick<
			PendingCredential,
			"token" | "tokenId" | "issuedAt" | "expiresAt" | "refreshRecommendedAt"
		>,
		issuer?: "plugin",
		expectedRevision?: number,
	) {
		const now = this.now();
		const identity = await this.store.connection();
		const connection =
			identity?.revokedAt === null ? await this.current() : null;
		const inheritedPairing = Boolean(
			connection &&
				connection.revokedAt === null &&
				connection.pairedAt !== null &&
				connection.subscription &&
				(connection.subscription.expiresAt === null ||
					connection.subscription.expiresAt > now),
		)
			? connection
			: null;
		const state = await this.store.updateExternal((previous) => {
			if (expectedRevision !== undefined && previous?.revision !== expectedRevision)
				throw new Error("dot_candidate_stale");
			const state = previous ?? {
				v: 1 as const,
				revision: 0,
				current: null,
				pending: null,
				endpoint: { mode: "absent" as const },
			};
			const pending: PendingCredential = {
				kind: "pending",
				...(issuer ? { issuer } : {}),
				...(issuer === "plugin" ? {pluginInstanceId:this.host.pluginInstanceId} : {}),
				candidateId: randomUUID(),
				revision: (state.pending?.revision ?? 0) + 1,
				token: issued.token,
				tokenId: issued.tokenId,
				issuedAt: issued.issuedAt,
				expiresAt: issued.expiresAt,
				refreshRecommendedAt: issued.refreshRecommendedAt,
				createdAt: now,
				discoveredAt: null,
				pairingAttemptId: inheritedPairing?.attemptId ?? null,
				pairingRequired: inheritedPairing === null,
				binding: null,
				verificationEventId: null,
				verificationReadAt: null,
				verificationReplyAt: null,
				previousEndpoint:
					state.pending?.previousEndpoint ??
					(state.current ? state.endpoint : null),
			};
			return { ...state, revision: state.revision + 1, pending };
		});
		return state;
	}
	async inspectCurrentCredential() {
		const state = await this.externalState();
		if (state.current?.kind === "plugin")
			return {
				usable: credentialLive(state.current, this.now()),
				reason: credentialLive(state.current, this.now())
					? "usable"
					: "expired",
				refreshRecommended: false,
			};
		if (state.current?.kind !== "signed")
			return state.current
				? { usable: true, reason: "legacy" }
				: { usable: false, reason: "absent" };
		const capability = this.host.capability;
		if (!capability) return { usable: false, reason: "capability_unavailable" };
		return capability.inspectExternal({
			token: state.current.token,
			capabilityId: DOT_EXTERNAL_CAPABILITY_ID,
		});
	}
	async setLongLivedServerUrl(
		candidateId: string,
		serverUrl: string,
	): Promise<DotExternalState>;
	async setLongLivedServerUrl(serverUrl: string): Promise<DotExternalState>;
	async setLongLivedServerUrl(candidateOrUrl: string, maybeUrl?: string) {
		const captured =
			maybeUrl === undefined
				? (await this.externalState()).pending?.candidateId
				: candidateOrUrl;
		const serverUrl = maybeUrl ?? candidateOrUrl;
		if (!captured) throw new Error("dot_pending_credential_required");
		return this.store.updateExternal((state) => {
			if (!state?.pending || state.pending.candidateId !== captured)
				throw new Error("dot_candidate_stale");
			return {
				...state,
				revision: state.revision + 1,
				endpoint: {
					mode: "long-lived",
					serverUrl,
					reachableAt: null,
				},
			};
		});
	}
	async setTemporaryLease(
		candidateId: string,
		lease: {
			readonly generation: string;
			readonly serverUrl: string;
			readonly startedAt: number;
			readonly expiresAt: number;
		},
	) {
		return this.store.updateExternal((state) => {
			if (!state?.pending || state.pending.candidateId !== candidateId)
				throw new Error("dot_candidate_stale");
			return {
				...state,
				revision: state.revision + 1,
				endpoint: {
					mode: "temporary-active",
					...lease,
					reachableAt: this.now(),
				},
			};
		});
	}
	async expireTemporary(generation: string) {
		return this.store.updateExternal((state) => {
			if (
				!state ||
				state.endpoint.mode !== "temporary-active" ||
				state.endpoint.generation !== generation
			)
				return (
					state ?? {
						v: 1,
						revision: 1,
						current: null,
						pending: null,
						endpoint: { mode: "absent" },
					}
				);
			return {
				...state,
				revision: state.revision + 1,
				endpoint: {
					mode: "temporary-expired",
					generation,
					expiresAt: state.endpoint.expiresAt,
				},
			};
		});
	}
	async cancelPending() {
		return this.store.updateExternal((state) => {
			if (!state)
				return {
					v: 1,
					revision: 1,
					current: null,
					pending: null,
					endpoint: { mode: "absent" },
				};
			const endpoint =
				state.current && state.pending?.previousEndpoint
					? state.pending.previousEndpoint
					: { mode: "absent" as const };
			return {
				...state,
				revision: state.revision + 1,
				pending: null,
				endpoint,
			};
		});
	}
	async revokeExternal() {
		return this.store.updateExternal((state) => ({
			v: 1,
			revision: (state?.revision ?? 0) + 1,
			current: null,
			pending: null,
			endpoint: { mode: "absent" },
		}));
	}
	async serverUrl() {
		const endpoint = (await this.externalState()).endpoint;
		if (endpoint.mode === "long-lived") return endpoint.serverUrl;
		if (endpoint.mode === "temporary-active" && endpoint.expiresAt > this.now())
			return endpoint.serverUrl;
		throw new Error("dot_endpoint_unavailable");
	}
	async authenticatePluginToken(
		token: unknown,
	): Promise<VerifiedExternalCredential> {
		this.assertLive();
		if (typeof token !== "string" || token.length < 43 || token.length > 256)
			throw new Error("dot_mcp_unauthorized");
		const identity = await this.store.connection();
		if (
			identity &&
			identity.pluginInstanceId !== this.host.pluginInstanceId
		)
			throw new Error("dot_mcp_unauthorized");
		const external = await this.externalState();
		const credential =
			external.pending?.issuer === "plugin" &&
			equalSecret(external.pending.token, token)
				? external.pending
				: external.current?.kind === "plugin" &&
						equalSecret(external.current.token, token)
					? external.current
					: null;
		if (!credential || credential.pluginInstanceId !== this.host.pluginInstanceId || !credentialLive(credential, this.now()))
			throw new Error("dot_mcp_unauthorized");
		// A new owner-issued candidate may be discovered before the next pairing step.
		// Its ordinary tools remain denied by the pending lane; revoked formal keys cannot return.
		if (identity?.revokedAt != null && credential === external.current)
			throw new Error("dot_mcp_unauthorized");
		return {
			origin: "plugin",
			sub: this.host.pluginInstanceId,
			cap: DOT_EXTERNAL_CAPABILITY_ID,
			jti: credential.tokenId,
			iat: credential.issuedAt,
			exp: credential.expiresAt,
		};
	}
	async authorizeExternal(
		credential: VerifiedExternalCredential | undefined,
		operation: ExternalOperation,
		eventId?: string,
	) {
		const state = await this.externalState();
		if (!credential) {
			if (state.current?.kind === "legacy")
				return { lane: "current" as const, tokenId: "legacy" };
			throw new Error("dot_external_credential_required");
		}
		if (
			credential.origin === "plugin" &&
			!credentialLive({ expiresAt: credential.exp }, this.now())
		)
			throw new Error("dot_external_credential_rejected");
		if (
			credential.sub !== this.host.pluginInstanceId ||
			credential.cap !== DOT_EXTERNAL_CAPABILITY_ID
		)
			throw new Error("dot_external_credential_mismatch");
		if (
			state.current &&
			state.current.kind !== "legacy" &&
			(state.current.kind === "plugin") === (credential.origin === "plugin") &&
			state.current.tokenId === credential.jti
		)
			return { lane: "current" as const, tokenId: credential.jti };
		const pending = state.pending;
		if (
			!pending ||
			(pending.issuer === "plugin") !== (credential.origin === "plugin") ||
			pending.tokenId !== credential.jti
		)
			throw new Error("dot_external_credential_rejected");
		const verification =
			operation === "verification-read" ||
			operation === "verification-reply" ||
			operation === "read" ||
			operation === "reply";
		const initialSubscribe =
			operation === "pairing-subscribe" &&
			(pending.binding !== undefined || pending.pairingRequired);
		if (!verification && operation !== "discovery" && !initialSubscribe)
			throw new Error("dot_pending_operation_rejected");
		if (verification && pending.verificationEventId !== eventId)
			throw new Error("dot_pending_verification_rejected");
		return {
			lane: "pending" as const,
			tokenId: credential.jti,
			candidateId: pending.candidateId,
		};
	}
	async recordDiscovery(credential: VerifiedExternalCredential | undefined) {
		const authorized = await this.authorizeExternal(credential, "discovery");
		if (authorized.lane !== "pending") return authorized;
		await this.store.updateExternal((state) => {
			if (
				!state?.pending ||
				state.pending.tokenId !== authorized.tokenId ||
				state.pending.candidateId !== authorized.candidateId
			)
				throw new Error("dot_candidate_stale");
			const discoveredAt = this.now();
			const endpoint =
				state.endpoint.mode === "long-lived"
					? { ...state.endpoint, reachableAt: discoveredAt }
					: state.endpoint;
			return {
				...state,
				revision: state.revision + 1,
				endpoint,
				pending: { ...state.pending, discoveredAt },
			};
		});
		return authorized;
	}
	async bindPendingPairing(attemptId: string) {
		await this.store.updateExternal((state) => {
			if (!state?.pending) throw new Error("dot_pending_credential_required");
			if (
				!state.pending.pairingRequired &&
				state.pending.pairingAttemptId !== attemptId
			)
				throw new Error("dot_candidate_pairing_mismatch");
			return {
				...state,
				revision: state.revision + 1,
				pending: {
					...state.pending,
					...(state.pending.binding !== undefined &&
					state.pending.pairingAttemptId !== attemptId
						? {
								binding: null,
								pairingIntent: undefined,
								verificationEventId: null,
								verificationReadAt: null,
								verificationReplyAt: null,
								verificationBindingVersion: undefined,
							}
						: {}),
					pairingAttemptId: attemptId,
				},
			};
		});
	}
	async bindPendingVerification(eventId: string, captured?: BoundConnection) {
		await this.store.updateExternal((state) => {
			if (!state?.pending || state.pending.discoveredAt === null)
				throw new Error("dot_pending_discovery_required");
			if (
				captured?.bindingAuthority?.candidateId &&
				(state.pending.candidateId !== captured.bindingAuthority.candidateId ||
					state.pending.binding?.version !== captured.bindingAuthority.version)
			)
				throw new Error("dot_candidate_stale");
			return {
				...state,
				revision: state.revision + 1,
				pending: {
					...state.pending,
					verificationEventId: eventId,
					...(state.pending.binding
						? { verificationBindingVersion: state.pending.binding.version }
						: {}),
					verificationReadAt: null,
					verificationReplyAt: null,
				},
			};
		});
	}
	async recordPendingEvidence(
		credential: VerifiedExternalCredential | undefined,
		eventId: string,
		kind: "read" | "reply",
	) {
		const authorized = await this.authorizeExternal(
			credential,
			kind === "read" ? "verification-read" : "verification-reply",
			eventId,
		);
		if (authorized.lane !== "pending") return;
		const record = await this.store.dispatch(eventId);
		if (record?.candidateProof) await this.forDispatch(record);
		const updated = await this.store.updateExternal((state) => {
			const pending = state?.pending;
			if (
				!pending ||
				pending.tokenId !== authorized.tokenId ||
				pending.candidateId !== authorized.candidateId ||
				pending.verificationEventId !== eventId ||
				(record?.candidateProof &&
					(pending.binding?.version !== record.candidateProof.bindingVersion ||
						pending.candidateId !== record.candidateProof.candidateId ||
						pending.tokenId !== record.candidateProof.tokenId))
			)
				throw new Error("dot_candidate_stale");
			return {
				...state,
				revision: state.revision + 1,
				pending: {
					...pending,
					...(kind === "read"
						? { verificationReadAt: this.now() }
						: { verificationReplyAt: this.now() }),
				},
			};
		});
		const pending = updated.pending;
		if (
			!pending ||
			pending.discoveredAt === null ||
			pending.verificationReadAt === null ||
			pending.verificationReplyAt === null
		)
			return;
		const connection = record?.candidateProof
			? await this.forDispatch(record)
			: await this.ready();
		if (pending.pairingAttemptId !== connection.attemptId)
			throw new Error("dot_candidate_pairing_mismatch");
		await this.store.updateExternal((state) => {
			const exact = state?.pending;
			if (
				!exact ||
				exact.candidateId !== pending.candidateId ||
				exact.revision !== pending.revision ||
				exact.tokenId !== pending.tokenId ||
				exact.verificationEventId !== eventId ||
				!credentialLive(exact, this.now()) ||
				exact.discoveredAt === null ||
				exact.verificationReadAt === null ||
				exact.verificationReplyAt === null ||
				(exact.binding !== undefined &&
					(!exact.binding?.subscription ||
						exact.binding.version !== exact.verificationBindingVersion ||
						(exact.binding.subscription.expiresAt !== null &&
							exact.binding.subscription.expiresAt <= this.now())))
			)
				throw new Error("dot_candidate_stale");
			return {
				...state,
				revision: state.revision + 1,
				current: currentCredentialSchema.parse({
					kind: exact.issuer === "plugin" ? "plugin" : "signed",
					...(exact.issuer === "plugin" ? {pluginInstanceId:exact.pluginInstanceId} : {}),
					token: exact.token,
					tokenId: exact.tokenId,
					issuedAt: exact.issuedAt,
					expiresAt: exact.expiresAt,
					refreshRecommendedAt: exact.refreshRecommendedAt,
					verifiedEventId: eventId,
					...(exact.binding ? { binding: exact.binding } : {}),
				}),
				pending: null,
			};
		});
	}
	captureFence() {
		const context = this.operations.getStore();
		return () => this.checkCurrent(context);
	}
	get operationSignal() {
		const context = this.operations.getStore();
		return context
			? AbortSignal.any([this.signal, context.signal])
			: this.signal;
	}
	async sameAttempt(state: BoundConnection, requireReady = true) {
		const a = state.bindingAuthority;
		const current = a?.candidateId
			? await this.candidateReady(
					{
						candidateId: a.candidateId,
						tokenId: a.tokenId!,
						bindingVersion: a.version!,
					},
					a.eventId,
				)
			: await (requireReady ? this.ready() : this.current());
		if (a && !a.candidateId && a.key !== current.bindingAuthority?.key)
			throw new Error("dot_binding_stale");
		if (
			current.attemptId !== state.attemptId ||
			current.ownerUserId !== state.ownerUserId ||
			current.agentKeyId !== state.agentKeyId ||
			current.pluginInstanceId !== state.pluginInstanceId
		)
			throw new Error("dot_stale_connection");
		if (
			!requireReady &&
			current.pairedAt === null &&
			current.pairingExpiresAt <= this.now()
		)
			throw new Error("dot_pairing_expired_or_mismatched");
		return current;
	}
	pairingFence(state: BoundConnection, requireReady = true) {
		const requestFence = this.captureFence();
		return async () => {
			await requestFence();
			await this.sameAttempt(state, requireReady);
		};
	}
	async owner(context?: PluginHostActionContext) {
		this.assertLive();
		if (
			!context ||
			!["owner-operation", "owner-http-request"].includes(context.kind) ||
			context.pluginInstanceId !== this.host.pluginInstanceId ||
			!context.userId
		)
			throw new Error("dot_owner_required");
		context.signal.throwIfAborted();
		await context.assertCurrent();
		this.assertLive();
		const state = await this.store.connection();
		if (state && state.ownerUserId !== context.userId)
			throw new Error("dot_owner_mismatch");
		return context.userId;
	}
	private applyBinding(
		state: DotConnectionState,
		binding: import("./external-state.js").CallbackBinding,
		authority: NonNullable<BoundConnection["bindingAuthority"]>,
	): BoundConnection {
		if (binding.attemptId !== state.attemptId)
			throw new Error("dot_binding_attempt_mismatch");
		return {
			...state,
			subscription: binding.subscription,
			pairedAt: binding.pairedAt,
			pairedCallbackUrl: binding.pairedCallbackUrl,
			pairingCode: binding.pairingCode,
			pairingExpiresAt: binding.pairingExpiresAt,
			bindingAuthority: authority,
		};
	}
	async current(): Promise<BoundConnection> {
		this.assertLive();
		const state = await this.store.connection();
		if (
			!state ||
			state.revokedAt !== null ||
			state.pluginInstanceId !== this.host.pluginInstanceId
		)
			throw new Error("dot_connection_unavailable");
		const external = await this.store.external();
		if (
			external?.current &&
			external.current.kind !== "legacy" &&
			external.current.binding !== undefined
		) {
			const binding = external.current.binding;
			return this.applyBinding(state, binding, {
				key: digest([external.current.tokenId, binding.version]),
				tokenId: external.current.tokenId,
				version: binding.version,
			});
		}
		return {
			...state,
			bindingAuthority: {
				key: digest([
					"legacy",
					state.attemptId,
					state.subscription,
					state.pairedCallbackUrl,
				]),
			},
		};
	}
	private requireSubscription(state: BoundConnection) {
		if (
			state.pairedAt === null ||
			!state.subscription ||
			(state.subscription.expiresAt !== null &&
				state.subscription.expiresAt <= this.now())
		)
			throw new Error("dot_subscription_required");
		return state;
	}
	async ready() {
		return this.requireSubscription(await this.current());
	}
	async candidateReady(
		proof?: { candidateId: string; tokenId: string; bindingVersion: number },
		eventId?: string,
	): Promise<BoundConnection> {
		const identity = await this.current();
		const external = await this.externalState();
		const pending = external.pending;
		if (
			proof &&
			!pending &&
			external.current &&
			external.current.kind !== "legacy" &&
			external.current.tokenId === proof.tokenId &&
			external.current.verifiedEventId === eventId &&
			external.current.binding?.version === proof.bindingVersion
		)
			return this.requireSubscription(identity);
		if (
			!pending ||
			!pending.binding ||
			!credentialLive(pending, this.now()) ||
			pending.discoveredAt === null ||
			pending.pairingAttemptId !== identity.attemptId
		)
			throw new Error("dot_candidate_binding_required");
		if (
			proof &&
			(pending.candidateId !== proof.candidateId ||
				pending.tokenId !== proof.tokenId ||
				pending.binding.version !== proof.bindingVersion ||
				(eventId !== undefined &&
					(pending.verificationEventId !== eventId ||
						pending.verificationBindingVersion !== proof.bindingVersion)))
		)
			throw new Error("dot_candidate_stale");
		return this.requireSubscription(
			this.applyBinding(identity, pending.binding, {
				key: digest([
					pending.candidateId,
					pending.tokenId,
					pending.binding.version,
				]),
				candidateId: pending.candidateId,
				tokenId: pending.tokenId,
				version: pending.binding.version,
				...(eventId ? { eventId } : {}),
			}),
		);
	}
	async forDispatch(record: import("./store.js").Dispatch) {
		return record.candidateProof
			? this.candidateReady(record.candidateProof, record.eventId)
			: this.ready();
	}
	async testState() {
		const external = await this.externalState();
		return external.pending?.binding !== undefined
			? this.candidateReady()
			: this.ready();
	}
	async statusState() {
		const state = await this.store.connection();
		if (!state || state.revokedAt !== null) return state;
		const external = await this.externalState();
		if (external.pending?.binding)
			return this.applyBinding(state, external.pending.binding, {
				key: "status",
			});
		if (external.pending?.binding === null && external.pending.pairingIntent)
			return {
				...state,
				pairedAt: null,
				subscription: null,
				pairingExpiresAt: external.pending.pairingIntent.expiresAt,
			};
		return this.current();
	}
	async begin(
		context: PluginHostActionContext | undefined,
		reconnect = false,
		assertAuthority: () => Promise<unknown> = async () => {},
	) {
		await assertAuthority();
		const owner = await this.owner(context);
		if (reconnect) {
			const e = await this.externalState();
			if (
				e.current &&
				e.current.kind !== "legacy" &&
				e.current.binding !== undefined
			)
				await this.revokeExternal();
			else await this.cancelPending();
		}
		await assertAuthority();
		const priorIdentity = await this.store.connection();
		const effective =
			priorIdentity?.revokedAt === null ? await this.current() : null;
		const bound = (await this.externalState()).current;
		const state = await this.store.updateConnection((previous) => {
			this.assertLive();
			if (previous && previous.ownerUserId !== owner)
				throw new Error("dot_owner_mismatch");
			if (
				!reconnect &&
				previous?.revokedAt === null &&
				previous.pluginInstanceId === this.host.pluginInstanceId &&
				((effective?.attemptId === previous.attemptId &&
					(effective.pairedAt !== null ||
						effective.pairingExpiresAt > this.now())) ||
					(bound &&
						bound.kind !== "legacy" &&
						bound.binding?.attemptId === previous.attemptId))
			)
				return previous;
			return {
				v: 1,
				revision: (previous?.revision ?? 0) + 1,
				ownerUserId: owner,
				pluginInstanceId: this.host.pluginInstanceId,
				agentKeyId: `plugin:${randomUUID()}`,
				attemptId: randomUUID(),
				pairingCode: randomBytes(16).toString("hex"),
				pairingExpiresAt: this.now() + 30 * 60000,
				pairedAt: null,
				pairedCallbackUrl: null,
				subscription: null,
				lastSourceReadAt: null,
				lastReplyAt: null,
				lastImageAt: null,
				revokedAt: null,
				testEventIds: [],
			};
		});
		try {
			await assertAuthority();
			const external = await this.externalState();
			if (external.pending) await this.bindPendingPairing(state.attemptId);
		} catch (error) {
			await this.store.updateConnection((current) => {
				if (!current || current.attemptId !== state.attemptId)
					throw new Error("dot_stale_connection");
				return {
					...current,
					revision: current.revision + 1,
					revokedAt: current.revokedAt ?? this.now(),
				};
			});
			throw error;
		}
		const external = await this.externalState();
		if (external.pending) {
			const pending = external.pending;
			const intent =
				pending.pairingIntent &&
				pending.pairingIntent.attemptId === state.attemptId &&
				pending.pairingIntent.expiresAt > this.now()
					? pending.pairingIntent
					: {
							code:
								state.pairedAt === null
									? state.pairingCode
									: randomBytes(16).toString("hex"),
							expiresAt: this.now() + 30 * 60000,
							attemptId: state.attemptId,
						};
			await this.store.updateExternal((value) => {
				if (
					!value?.pending ||
					value.pending.candidateId !== pending.candidateId
				)
					throw new Error("dot_candidate_stale");
				const changed = value.pending.pairingIntent?.code !== intent.code;
				return {
					...value,
					revision: value.revision + 1,
					pending: {
						...value.pending,
						pairingIntent: intent,
						...(value.pending.binding === undefined
							? {
									binding: null,
									verificationEventId: null,
									verificationReadAt: null,
									verificationReplyAt: null,
									verificationBindingVersion: undefined,
								}
							: {}),
						...(changed && value.pending.binding
							? {
									binding: {
										...value.pending.binding,
										version: value.pending.binding.version + 1,
										pairingCode: intent.code,
										pairingExpiresAt: intent.expiresAt,
									},
									verificationEventId: null,
									verificationReadAt: null,
									verificationReplyAt: null,
									verificationBindingVersion: undefined,
								}
							: {}),
					},
				};
			});
			return this.instructionsFor({ ...state, pairingCode: intent.code });
		}
		const established = await this.current();
		if (
			external.current &&
			external.current.kind !== "legacy" &&
			external.current.binding &&
			!established.subscription
		) {
			const binding = external.current.binding,
				tokenId = external.current.tokenId;
			const code = randomBytes(16).toString("hex"),
				expiresAt = this.now() + 30 * 60000;
			await this.store.updateExternal((value) => {
				if (
					!value?.current ||
					value.current.kind === "legacy" ||
					value.current.tokenId !== tokenId ||
					value.current.binding?.version !== binding.version
				)
					throw new Error("dot_binding_stale");
				return {
					...value,
					revision: value.revision + 1,
					current: {
						...value.current,
						binding: {
							...binding,
							version: binding.version + 1,
							pairingCode: code,
							pairingExpiresAt: expiresAt,
						},
					},
				};
			});
			return this.instructionsFor(await this.current());
		}
		return this.instructionsFor(established);
	}
	private instructionsFor(state: DotConnectionState) {
		return {
			...this.project(state),
			pairingCode: state.pairingCode,
			instructions: `请把这个 ChatGPT Work 对话连接到 Clowder AI 的 Dot。请实际调用 events/subscribe 订阅 dot.summoned，参数为 attempt_id=${state.attemptId}，pairing_code=${state.pairingCode}。收到事件后，先调用 cat_cafe_dot_read_source 读取原消息，再调用 cat_cafe_dot_reply 把回复发回原对话；若原消息要求校验码，请在回复中保留校验码。请完成订阅，不要只解释操作步骤。`,
		};
	}
	async instructions(context: PluginHostActionContext | undefined) {
		await this.owner(context);
		const state = await this.current();
		if (state.pairedAt === null && state.pairingExpiresAt <= this.now())
			throw new Error("dot_pairing_expired_or_mismatched");
		return this.instructionsFor(state);
	}
	private async subscribeCandidate(
		input: {
			attemptId: string;
			pairingCode: string;
			url: string;
			secret: string;
			ttlMs?: number | null;
		},
		credential: VerifiedExternalCredential,
	) {
		const captured = (await this.externalState()).pending;
		if (!captured?.pairingIntent || captured.discoveredAt === null)
			throw new Error("dot_pending_pairing_intent_required");
		const intent = captured.pairingIntent;
		const validate = async () => {
			await this.assertCurrent();
			const identity = await this.current(),
				p = (await this.externalState()).pending;
			if (
				!p ||
				p.candidateId !== captured.candidateId ||
				p.tokenId !== credential.jti ||
				p.binding?.version !== captured.binding?.version ||
				p.discoveredAt === null ||
				!credentialLive(p, this.now()) ||
				p.pairingIntent?.code !== intent.code ||
				intent.expiresAt <= this.now() ||
				identity.attemptId !== intent.attemptId ||
				input.attemptId !== intent.attemptId ||
				!equalSecret(input.pairingCode, intent.code)
			)
				throw new Error("dot_candidate_stale");
		};
		await validate();
		const ttl =
			input.ttlMs == null ? null : Math.min(input.ttlMs, 7 * 24 * 60 * 60000);
		if (ttl !== null && (!Number.isSafeInteger(ttl) || ttl <= 0))
			throw new Error("dot_invalid_subscription_ttl");
		const state = await this.current();
		const id =
			"dot_" +
			digest([state.ownerUserId, state.agentKeyId, state.attemptId, input.url]);
		await verifyDotWebhook(
			input.url,
			id,
			input.secret,
			this.send,
			this.operationSignal,
			validate,
		);
		await validate();
		const old = captured.binding?.subscription;
		if (
			old?.url === input.url &&
			old.secret === input.secret &&
			(old.expiresAt === null || old.expiresAt > this.now())
		)
			return {
				id: old.id,
				refreshBefore:
					old.expiresAt === null ? null : new Date(old.expiresAt).toISOString(),
				cursor: null,
				truncated: false,
			};
		const expiresAt = ttl === null ? null : this.now() + ttl;
		await this.store.updateExternal((value) => {
			const p = value?.pending;
			if (
				!value ||
				!p ||
				p.candidateId !== captured.candidateId ||
				p.tokenId !== credential.jti ||
				p.binding?.version !== captured.binding?.version ||
				p.pairingIntent?.code !== intent.code ||
				!credentialLive(p, this.now()) ||
				intent.expiresAt <= this.now()
			)
				throw new Error("dot_candidate_stale");
			const pending = p;
			return {
				...value,
				revision: value.revision + 1,
				pending: {
					...pending,
					revision: p.revision + 1,
					binding: {
						attemptId: state.attemptId,
						pairingCode: intent.code,
						pairingExpiresAt: intent.expiresAt,
						version: (p.binding?.version ?? 0) + 1,
						pairedCallbackUrl: input.url,
						pairedAt: this.now(),
						subscription: {
							id,
							url: input.url,
							secret: input.secret,
							expiresAt,
							verifiedAt: this.now(),
							previousSecret: null,
							rotationUntil: null,
						},
					},
					verificationEventId: null,
					verificationReadAt: null,
					verificationReplyAt: null,
					verificationBindingVersion: undefined,
				},
			};
		});
		return {
			id,
			refreshBefore:
				expiresAt === null ? null : new Date(expiresAt).toISOString(),
			cursor: null,
			truncated: false,
		};
	}
	async subscribe(
		input: {
			attemptId: string;
			pairingCode: string;
			url: string;
			secret: string;
			ttlMs?: number | null;
		},
		credential?: VerifiedExternalCredential,
	) {
		const state = await this.current();
		const lane = credential
			? await this.authorizeExternal(credential, "pairing-subscribe")
			: undefined;
		if (
			lane?.lane === "pending" &&
			(await this.externalState()).pending?.binding !== undefined
		)
			return this.subscribeCandidate(input, credential!);
		if (state.attemptId !== input.attemptId)
			throw new Error("dot_attempt_mismatch");
		const pinned = state.pairedCallbackUrl ?? state.subscription?.url;
		if (pinned && pinned !== input.url) throw new Error("dot_repair_required");
		if (
			!equalSecret(input.pairingCode, state.pairingCode) ||
			(state.pairedAt === null && state.pairingExpiresAt <= this.now())
		)
			throw new Error("dot_pairing_expired_or_mismatched");
		const ttl =
			input.ttlMs === undefined || input.ttlMs === null
				? null
				: Math.min(input.ttlMs, 7 * 24 * 60 * 60000);
		if (ttl !== null && (!Number.isSafeInteger(ttl) || ttl <= 0))
			throw new Error("dot_invalid_subscription_ttl");
		const id = `dot_${digest([state.ownerUserId, state.agentKeyId, state.attemptId, input.url])}`;
		await verifyDotWebhook(
			input.url,
			id,
			input.secret,
			this.send,
			this.operationSignal,
			this.pairingFence(state, false),
		);
		this.assertLive();
		await this.sameAttempt(state, false);
		if (credential)
			await this.authorizeExternal(credential, "pairing-subscribe");
		const expiresAt = ttl === null ? null : this.now() + ttl;
		if (state.bindingAuthority?.tokenId) {
			const authority = state.bindingAuthority;
			await this.store.updateExternal((value) => {
				if (
					!value?.current ||
					value.current.kind === "legacy" ||
					value.current.tokenId !== authority.tokenId ||
					!value.current.binding ||
					value.current.binding.version !== authority.version
				)
					throw new Error("dot_binding_stale");
				const binding = value.current.binding;
				return {
					...value,
					revision: value.revision + 1,
					current: {
						...value.current,
						binding: {
							...binding,
							version: binding.version + 1,
							pairedAt: this.now(),
							pairedCallbackUrl: input.url,
							subscription: {
								id,
								url: input.url,
								secret: input.secret,
								expiresAt,
								verifiedAt: this.now(),
								previousSecret: state.subscription?.secret ?? null,
								rotationUntil: this.now() + 5 * 60000,
							},
						},
					},
				};
			});
			return {
				id,
				refreshBefore:
					expiresAt === null ? null : new Date(expiresAt).toISOString(),
				cursor: null,
				truncated: false,
			};
		}
		await this.store.updateConnection((current) => {
			this.assertLive();
			if (
				!current ||
				current.revision !== state.revision ||
				current.revokedAt !== null
			)
				throw new Error("dot_stale_connection");
			const prior = current.subscription;
			return {
				...current,
				revision: current.revision + 1,
				pairedAt: this.now(),
				pairedCallbackUrl: input.url,
				subscription: {
					id,
					url: input.url,
					secret: input.secret,
					expiresAt,
					verifiedAt: this.now(),
					previousSecret:
						prior && prior.secret !== input.secret
							? prior.secret
							: (prior?.previousSecret ?? null),
					rotationUntil:
						prior && prior.secret !== input.secret
							? this.now() + 5 * 60000
							: (prior?.rotationUntil ?? null),
				},
			};
		});
		return {
			id,
			refreshBefore:
				expiresAt === null ? null : new Date(expiresAt).toISOString(),
			cursor: null,
			truncated: false,
		};
	}
	async unsubscribe(
		input: {
			attemptId: string;
			pairingCode: string;
			url: string;
		},
		credential?: VerifiedExternalCredential,
	) {
		if (credential)
			await this.authorizeExternal(credential, "pairing-unsubscribe");
		const state = await this.current();
		if (
			state.attemptId !== input.attemptId ||
			!equalSecret(state.pairingCode, input.pairingCode) ||
			(state.subscription && state.subscription.url !== input.url)
		)
			throw new Error("dot_subscription_mismatch");
		await this.store.updateExternal((value) => {
			if (!value) throw new Error("dot_binding_stale");
			if (state.bindingAuthority?.tokenId) {
				if (
					!value.current ||
					value.current.kind === "legacy" ||
					value.current.tokenId !== state.bindingAuthority.tokenId ||
					!value.current.binding ||
					value.current.binding.version !== state.bindingAuthority.version
				)
					throw new Error("dot_binding_stale");
				return {
					...value,
					revision: value.revision + 1,
					pending: null,
					current: {
						...value.current,
						binding: {
							...value.current.binding,
							version: value.current.binding.version + 1,
							subscription: null,
							pairedAt: null,
						},
					},
				};
			}
			return { ...value, revision: value.revision + 1, pending: null };
		});
		if (state.bindingAuthority?.tokenId) return {};
		await this.store.updateConnection((current) => {
			this.assertLive();
			if (!current || current.revision !== state.revision)
				throw new Error("dot_stale_connection");
			return {
				...current,
				revision: current.revision + 1,
				pairedCallbackUrl:
					current.pairedCallbackUrl ?? current.subscription?.url ?? null,
				pairedAt: null,
				subscription: null,
			};
		});
		return {};
	}
	async disconnect(context?: PluginHostActionContext) {
		await this.owner(context);
		await this.store.updateConnection((state) => {
			this.assertLive();
			if (!state) throw new Error("dot_connection_missing");
			return {
				...state,
				revision: state.revision + 1,
				revokedAt: state.revokedAt ?? this.now(),
			};
		});
		return {};
	}
	async evidence(state: DotConnectionState, kind: "read" | "reply" | "image") {
		await this.sameAttempt(state, false);
		await this.store.updateConnection((current) => {
			this.assertLive();
			if (
				!current ||
				current.attemptId !== state.attemptId ||
				current.revokedAt !== null
			)
				throw new Error("dot_stale_connection");
			const field =
				kind === "read"
					? "lastSourceReadAt"
					: kind === "reply"
						? "lastReplyAt"
						: "lastImageAt";
			return {
				...current,
				revision: current.revision + 1,
				[field]: this.now(),
			};
		});
	}
	project(state: DotConnectionState | null) {
		const active =
			state?.revokedAt === null &&
			state.pluginInstanceId === this.host.pluginInstanceId;
		return {
			pluginInstanceId: this.host.pluginInstanceId,
			attemptId: state?.attemptId ?? null,
			revision: state?.revision ?? null,
			paired: !!active && state?.pairedAt !== null,
			revoked: !!state && !active,
			subscription: !state?.subscription
				? "absent"
				: active &&
						(state.subscription.expiresAt === null ||
							state.subscription.expiresAt > this.now())
					? "active"
					: "expired",
			sourceReadAt: state?.lastSourceReadAt ?? null,
			replyAt: state?.lastReplyAt ?? null,
			imageAt: state?.lastImageAt ?? null,
			pairingExpiresAt: state?.pairingExpiresAt ?? null,
		};
	}
}
