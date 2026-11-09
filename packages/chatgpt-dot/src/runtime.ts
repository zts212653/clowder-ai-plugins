import { AutomaticDotVerification } from "./automatic-verification.js";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	PluginDeliveryReceipt,
	PluginMessageDelivery,
} from "@clowder-ai/plugin-contract";
import type {
	ModulePluginHostShape,
	PluginMessage,
	PluginStreams,
} from "@clowder-ai/plugin-sdk";
import sharp from "sharp";
import { z } from "zod";
import {
	DOT_EXTERNAL_CAPABILITY_ID,
	type DotConnection,
} from "./connection.js";
import type { VerifiedExternalCredential } from "./external-state.js";
import { dotWebhookHeaders } from "./dot-webhook.js";
import { retainImageFile } from "./image-file.js";
import { fenceAsyncPort } from "./operation-fence.js";
import {
	dotAskArguments,
	dotAskText,
	dotImageArguments,
	textPayload,
} from "./protocol.js";
import { type Dispatch, digest, eventId } from "./store.js";
export const imageSchema = z
	.object({
		id: z.string().regex(/^dot_img_[a-f0-9]{64}$/),
		ownerUserId: z.string().min(1),
		threadId: z.string().min(1),
		eventId: z.string().regex(/^dot_evt_[a-f0-9]{64}$/),
		publicationKey: z.string().min(1),
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
		byteSize: z.number().int().positive(),
		width: z.number().int().positive(),
		height: z.number().int().positive(),
		messageId: z.string().nullable(),
		alt: z.string(),
	})
	.strict();
export type ImageAsset = z.infer<typeof imageSchema>;
export async function validatePng(encoded: string) {
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
		throw new Error("invalid_base64");
	const bytes = Buffer.from(encoded, "base64");
	if (bytes.length > 10 * 1024 * 1024) throw new Error("image_too_large");
	if (bytes.toString("base64") !== encoded) throw new Error("invalid_base64");
	if (
		!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
	)
		throw new Error("invalid_png");
	try {
		const image = sharp(bytes, { limitInputPixels: 40000000, failOn: "error" }),
			meta = await image.metadata();
		if (
			meta.format !== "png" ||
			!meta.width ||
			!meta.height ||
			(meta.pages && meta.pages > 1)
		)
			throw new Error("invalid_png");
		await image.stats();
		return { bytes, width: meta.width, height: meta.height };
	} catch {
		throw new Error("invalid_png");
	}
}
export function imageReference(id: string): string {
	if (!/^dot_img_[a-f0-9]{64}$/.test(id))
		throw new Error("dot_image_id_invalid");
	return `pmr_dot_${id.slice("dot_img_".length)}`;
}
export class DotRuntime {
	readonly verification: AutomaticDotVerification;
	private readonly pending = new Map<string, Promise<unknown>>();
	private askRevision = 0;
	constructor(
		readonly host: ModulePluginHostShape,
		readonly connection: DotConnection,
		verificationDelayMs?: number,
	) {
		this.verification = new AutomaticDotVerification(this, verificationDelayMs);
		const fence = () => connection.assertCurrent();
		this.host = {
			...host,
			storage: connection.store.storage,
			messaging: fenceAsyncPort(host.messaging, fence),
			threads: fenceAsyncPort(host.threads, fence),
		};
	}
	async serial<T>(key: string, run: () => Promise<T>): Promise<T> {
		const task = (this.pending.get(key) ?? Promise.resolve())
			.catch(() => undefined)
			.then(run);
		this.pending.set(key, task);
		try {
			return await task;
		} finally {
			if (this.pending.get(key) === task) this.pending.delete(key);
		}
	}
	async settle() {
		this.verification.stop();
		await this.verification.settle();
		await Promise.allSettled([...this.pending.values()]);
	}
	async source(
		record: Dispatch,
		state: Awaited<ReturnType<DotConnection["ready"]>>,
	) {
		const current = await this.connection.forDispatch(record);
		if (
			current.attemptId !== record.attemptId ||
			current.ownerUserId !== record.ownerUserId
		)
			throw new Error("dot_stale_dispatch");
		const thread = await this.host.threads.get(record.threadId);
		const source = await this.host.messaging.get(record.sourceMessageId);
		this.connection.assertLive();
		if (
			!thread ||
			!source ||
			source.threadId !== record.threadId ||
			source.userId !== record.ownerUserId ||
			(record.sourceRevision && source.sourceRevision !== record.sourceRevision)
		)
			throw new Error("dot_source_unavailable");
		// The Host reads may outlive reconnect, disconnect or subscription expiry.
		// All source-authorized effects must use authority observed after those reads.
		await this.connection.sameAttempt(state);
		return source;
	}
	async authorize(id: string, read = false) {
		let record = await this.connection.store.dispatch(id);
		if (!record) throw new Error("dot_dispatch_unavailable");
		const state = await this.connection.forDispatch(record);
		const source = await this.source(record, state);
		// Older acknowledged subscriptions will not be delivered again. Recover
		// alpha.49 Host subscription IDs have this stable family; addressed IDs
		// are ad_<digest> and must never lose their completion carrier. Unknown
		// IDs stay unchanged. This is old-format recovery, not current routing.
		if (!record.deliveryReason && /^delivery_[a-f0-9]{64}$/.test(record.deliveryId ?? "") && source.catId) {
			const parent = source.replyTo ?? source.extra?.causal?.triggerMessageId;
			for (const [key, entry] of Object.entries(await this.host.storage.list())) {
				if (!key.startsWith("dot/ask/")) continue;
				const ask = entry.value as {attemptId:string;threadId:string;messageId:string|null;recipientCatIds:string[]};
				if (parent && ask.messageId === parent && ask.attemptId === record.attemptId &&
					ask.threadId === record.threadId && ask.recipientCatIds.includes(source.catId)) {
					record = await this.connection.store.updateDispatch(id, current => {
						if (!current) throw new Error("dot_dispatch_unavailable");
						return current.deliveryReason ? current : {...current,deliveryReason:"subscription",deliveryId:undefined};
					});
					break;
				}
			}
		}
		if (read && record.sourceReadAt === null)
			throw new Error("dot_source_not_read");
		return { state, record, source };
	}
	async deliver(
		input: PluginMessageDelivery,
		expectedAttemptId?: string,
	): Promise<PluginDeliveryReceipt> {
		this.connection.assertLive();
		const state = await this.connection.current();
		if (!state) throw new Error("dot_subscription_required");
		if (
			expectedAttemptId !== undefined &&
			state.attemptId !== expectedAttemptId
		)
			throw new Error("dot_stale_connection");
		await this.connection.sameAttempt(state);
		if (input.threadId !== input.envelope.threadId)
			throw new Error("dot_source_mismatch");
		const source = await this.host.messaging.get(input.envelope.messageId);
		if (
			!source ||
			source.threadId !== input.threadId ||
			source.userId !== state.ownerUserId
		)
			throw new Error("dot_source_unavailable");
		// Host deliveryId is stable across execution retries and instance restarts.
		const id = eventId(
			state.attemptId,
			input.threadId,
			source.id,
			input.deliveryId,
		);
		await this.serial(id, async () => {
			const record = await this.connection.store.updateDispatch(id, (prior) => {
				this.connection.assertLive();
				return (
					prior ? {...prior, deliveryReason: input.reason, deliveryId: input.reason === "addressed" ? input.deliveryId : undefined} : {
						eventId: id,
						ownerUserId: state.ownerUserId,
						threadId: input.threadId,
						sourceMessageId: source.id,
						sourceRevision: source.sourceRevision,
						dispatchInvocationId: input.executionId ?? input.deliveryId,
						// Only explicit addressed work owns a Host target-response carrier.
						deliveryReason: input.reason,
						deliveryId: input.reason === "addressed" ? input.deliveryId : undefined,
						attemptId: state.attemptId,
						agentKeyId: state.agentKeyId,
						occurredAt: Date.now(),
						webhookAcknowledgedAt: null,
						sourceReadAt: null,
						replyMessageId: null,
						imagePublicationIds: [],
						connectionTest: false,
						deliveryError: null,
					}
				);
			});
			await this.source(record, state);
			if (record.webhookAcknowledgedAt !== null) return;
			await this.sendEvent(record);
		});
		return { deliveryId: input.deliveryId };
	}
	private async sendEvent(record: Dispatch) {
		for (let attempt = 0; attempt < 3; attempt++) {
			const { state } = await this.authorize(record.eventId),
				subscription = state.subscription!;
			const body = JSON.stringify({
				eventId: record.eventId,
				name: "dot.summoned",
				timestamp: new Date(record.occurredAt).toISOString(),
				data: {
					event_id: record.eventId,
					thread_id: record.threadId,
					source_message_id: record.sourceMessageId,
					dispatch_invocation_id: record.dispatchInvocationId,
				},
				cursor: null,
			});
			try {
				const result = await this.connection.send(
					subscription.url,
					dotWebhookHeaders(
						record.eventId,
						subscription.id,
						subscription.secret,
						body,
						Date.now(),
						subscription.rotationUntil &&
							subscription.rotationUntil > Date.now()
							? (subscription.previousSecret ?? undefined)
							: undefined,
					),
					body,
					this.connection.operationSignal,
					this.connection.pairingFence(state),
				);
				this.connection.assertLive();
				await this.authorize(record.eventId);
				if (result.status >= 200 && result.status < 300) {
					await this.connection.store.updateDispatch(
						record.eventId,
						(current) => {
							this.connection.assertLive();
							if (!current) throw new Error("dot_dispatch_unavailable");
							return { ...current, webhookAcknowledgedAt: Date.now() };
						},
					);
					return;
				}
				if (result.status < 500 && ![408, 429].includes(result.status)) break;
			} catch (error) {
				this.connection.assertLive();
				if (attempt === 2) throw error;
			}
		}
		throw new Error("dot_webhook_unacknowledged");
	}
	async read(id: string, credential?: VerifiedExternalCredential) {
		await this.connection.authorizeExternal(credential, "read", id);
		const proof = (await this.connection.store.dispatch(id))?.candidateProof;
		if (proof && credential?.jti !== proof.tokenId)
			throw new Error("dot_candidate_stale");
		const { state, record, source } = await this.authorize(id);
		const context = await this.host.threads.readMessages(record.threadId, {
			before: { timestamp: source.timestamp, id: source.id },
			limit: 30,
		});
		await this.authorize(id);
		await this.connection.authorizeExternal(credential, "read", id);
		await this.connection.store.updateDispatch(id, (current) => {
			this.connection.assertLive();
			if (!current) throw new Error("dot_dispatch_unavailable");
			return { ...current, sourceReadAt: Date.now() };
		});
		await this.connection.evidence(state, "read");
		await this.connection.recordPendingEvidence(credential, id, "read");
		return {
			eventId: id,
			threadId: record.threadId,
			source,
			context,
			complete: false,
			scope:
				"Up to 30 visible messages before the exact summon; source returned separately.",
			observedAt: Date.now(),
		};
	}
	async reply(
		id: string,
		content: string,
		credential?: VerifiedExternalCredential,
	) {
		return this.serial(id, async () => {
			await this.connection.authorizeExternal(credential, "reply", id);
			const proof = (await this.connection.store.dispatch(id))?.candidateProof;
			if (proof && credential?.jti !== proof.tokenId)
				throw new Error("dot_candidate_stale");
			const { state, record, source } = await this.authorize(id, true);
			if (record.expectedNonce && !content.includes(record.expectedNonce))
				throw new Error("dot_test_nonce_mismatch");
			const payload = textPayload(content);
			const contentDigest = digest(content);
			if (record.replyDigest && record.replyDigest !== contentDigest)
				throw new Error("dot_reply_conflict");
			if (record.replyMessageId) {
				await this.connection.recordPendingEvidence(credential, id, "reply");
				return { messageId: record.replyMessageId, duplicate: true };
			}
			await this.connection.store.updateDispatch(id, (current) => {
				this.connection.assertLive();
				if (!current) throw new Error("dot_dispatch_unavailable");
				if (current.replyDigest && current.replyDigest !== contentDigest)
					throw new Error("dot_reply_conflict");
				return { ...current, replyDigest: contentDigest };
			});
			await this.authorize(id, true);
			await this.connection.authorizeExternal(credential, "reply", id);
			const posted = await this.host.messaging.send({
				threadId: record.threadId,
				identity: "dot",
				replyTo: record.sourceMessageId,
				...(record.deliveryId
					? {
							response: {
								deliveryId: record.deliveryId,
								status: "completed" as const,
							},
						}
					: {}),
				idempotencyKey: `dot-reply:${id}`,
				sourceEventId: id,
				payload,
				meta: { eventId: id, attemptId: state.attemptId },
				...(source.catId ? { wake: { catId: source.catId } } : {}),
			});
			this.connection.assertLive();
			await this.authorize(id, true);
			await this.connection.store.updateDispatch(id, (current) => {
				this.connection.assertLive();
				if (!current) throw new Error("dot_dispatch_unavailable");
				return { ...current, replyMessageId: posted.messageId };
			});
			await this.connection.evidence(state, "reply");
			await this.connection.recordPendingEvidence(credential, id, "reply");
			return posted;
		});
	}
	async image(raw: z.infer<typeof dotImageArguments>, credential?: VerifiedExternalCredential) {
		const input = dotImageArguments.parse(raw);
		return this.serial(input.event_id, async () => {
			await this.connection.authorizeExternal(credential, "publish-image", input.event_id);
			const { state, record } = await this.authorize(input.event_id, true);
			const checked = await validatePng(input.png_base64),
				id = `dot_img_${digest([state.ownerUserId, record.eventId, input.publication_key])}`;
			const sha256 = createHash("sha256").update(checked.bytes).digest("hex"),
				key = `dot/image/${id}`;
			let asset = (await this.host.storage.get(key))?.value as
				| ImageAsset
				| undefined;
			if (asset) asset = imageSchema.parse(asset);
			if (
				asset &&
				(asset.sha256 !== sha256 || asset.alt !== (input.alt ?? "dot 原图"))
			)
				throw new Error("dot_publication_conflict");
			await this.connection.store.updateDispatch(record.eventId, (current) => {
				this.connection.assertLive();
				if (!current) throw new Error("dot_dispatch_unavailable");
				const reserved = new Set([
					...current.imagePublicationIds,
					...(current.imageReservationIds ?? []),
				]);
				if (!reserved.has(id) && reserved.size >= 8)
					throw new Error("dot_image_publication_limit");
				reserved.add(id);
				return { ...current, imageReservationIds: [...reserved] };
			});
			await this.authorize(record.eventId, true);
			if (!asset) {
				asset = {
					id,
					ownerUserId: state.ownerUserId,
					threadId: record.threadId,
					eventId: record.eventId,
					publicationKey: input.publication_key,
					sha256,
					byteSize: checked.bytes.length,
					width: checked.width,
					height: checked.height,
					messageId: null,
					alt: input.alt ?? "dot 原图",
				};
				const assertPublicationCurrent = this.connection.pairingFence(state);
				await retainImageFile(
					this.host.dataPath,
					id,
					checked.bytes,
					assertPublicationCurrent,
					"dot_publication_conflict",
				);
				await assertPublicationCurrent();
				const inserted = await this.host.storage.compareAndSet(
					key,
					null,
					asset,
				);
				if (!inserted.applied) {
					const existing = imageSchema.parse(
						(await this.host.storage.get(key))?.value,
					);
					if (existing.sha256 !== sha256)
						throw new Error("dot_publication_conflict");
					asset = existing;
				}
			}
			await this.imageBytes(asset);
			if (!asset.messageId) {
				await this.authorize(record.eventId, true);
				await this.connection.authorizeExternal(credential, "publish-image", record.eventId);
				const posted = await this.host.messaging.send({
					threadId: record.threadId,
					identity: "dot",
					replyTo: record.sourceMessageId,
					idempotencyKey: `dot-image:${id}`,
					sourceEventId: id,
					payload: {
						provenance: { epistemicStatus: "observation" },
						elements: [
							{
								elementId: "caption",
								kind: "text",
								payload: { text: asset.alt },
							},
							{
								elementId: "original",
								kind: "media_ref",
								payload: {
									type: "image",
									reference: imageReference(id),
									sourceId: "dot-images",
									fileName: `${id}.png`,
									mimeType: "image/png",
									sha256,
									byteSize: asset.byteSize,
									width: asset.width,
									height: asset.height,
								},
							},
						],
					},
				});
				this.connection.assertLive();
				asset = { ...asset, messageId: posted.messageId };
				await this.host.storage.set(key, asset);
			}
			await this.connection.store.updateDispatch(record.eventId, (current) => {
				this.connection.assertLive();
				if (!current) throw new Error("dot_dispatch_unavailable");
				return {
					...current,
					imagePublicationIds: [
						...new Set([...current.imagePublicationIds, id]),
					],
				};
			});
			await this.connection.evidence(state, "image");
			return {
				...asset,
				publicationId: id,
				reference: imageReference(id),
				mimeType: "image/png",
				original: true,
			};
		});
	}
	async imageBytes(asset: ImageAsset) {
		const bytes = await readFile(
			join(this.host.dataPath, "images", `${asset.id}.png`),
		);
		if (
			bytes.length !== asset.byteSize ||
			createHash("sha256").update(bytes).digest("hex") !== asset.sha256
		)
			throw new Error("dot_image_corrupt");
		this.connection.assertLive();
		return bytes;
	}
	readonly streams: PluginStreams = {
		read: (reference, options = {}) => {
			const runtime = this,
				fence = this.connection.captureFence();
			return {
				async *[Symbol.asyncIterator]() {
					await fence();
					runtime.connection.assertLive();
					options.signal?.throwIfAborted();
					if (!/^pmr_dot_[a-f0-9]{64}$/.test(reference))
						throw new Error("dot_image_access_denied");
					const id = `dot_img_${reference.slice("pmr_dot_".length)}`;
					const asset = imageSchema.parse(
						(await runtime.host.storage.get(`dot/image/${id}`))?.value,
					);
					const state = await runtime.connection.store.connection();
					if (!state || asset.ownerUserId !== state.ownerUserId)
						throw new Error("dot_image_access_denied");
					await runtime.authorize(asset.eventId, true);
					const bytes = await runtime.imageBytes(asset);
					for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
						await fence();
						await runtime.connection.sameAttempt(state);
						runtime.connection.assertLive();
						options.signal?.throwIfAborted();
						yield bytes.subarray(offset, offset + 64 * 1024);
					}
				},
			};
		},
	};
	async ask(raw: z.infer<typeof dotAskArguments>, credential?: VerifiedExternalCredential) {
		const input = dotAskArguments.parse(raw);
		const key = `dot/ask/${digest([input.attempt_id, input.client_message_id])}`;
		this.askRevision++;
		try {
			return await this.serial(key, () => this.sendAsk(input, credential));
		} finally {
			this.askRevision++;
		}
	}
	private async sendAsk(raw: z.infer<typeof dotAskArguments>, credential?: VerifiedExternalCredential) {
		await this.connection.authorizeExternal(credential, "ask");
		const input = dotAskArguments.parse(raw),
			state = await this.connection.ready();
		if (input.attempt_id !== state.attemptId)
			throw new Error("dot_attempt_mismatch");
		if (!(await this.host.threads.get(input.thread_id)))
			throw new Error("dot_ask_thread_rejected");
		const cats = await this.host.threads.getCats(input.thread_id),
			targets = [...new Set(input.target_cat_ids)].sort();
		const participants = cats.participants.filter((cat) =>
			cats.routableNow.some((available) => available.catId === cat.catId),
		);
		if (
			targets.some(
				(target) => !participants.some((cat) => cat.catId === target),
			)
		)
			throw new Error("dot_ask_recipient_rejected");
		const key = `dot/ask/${digest([state.attemptId, input.client_message_id])}`,
			requestDigest = digest([input.thread_id, targets, input.content]);
		const prior = await this.host.storage.get(key);
		if (
			prior &&
			(
				prior.value as {
					requestDigest: string;
				}
			).requestDigest !== requestDigest
		)
			throw new Error("dot_ask_idempotency_conflict");
		const allowed = new Set(
			participants
				.filter((cat) => targets.includes(cat.catId))
				.flatMap((cat) => [cat.catId, ...(cat.aliases ?? [])]),
		);
		for (const line of input.content.split("\n")) {
			const mention = /^\s*@([^\s]+)/.exec(line)?.[1];
			if (mention && !allowed.has(mention))
				throw new Error("dot_ask_target_mismatch");
		}
		const payload = textPayload(dotAskText(targets, input.content));
		const reservation = {
			requestDigest,
			attemptId: state.attemptId,
			threadId: input.thread_id,
			recipientCatIds: targets,
			messageId: null as string | null,
		};
		await this.connection.sameAttempt(state);
		if (
			!prior &&
			!(await this.host.storage.compareAndSet(key, null, reservation)).applied
		)
			throw new Error("dot_state_conflict");
		await this.connection.sameAttempt(state);
		this.connection.assertLive();
		await this.connection.authorizeExternal(credential, "ask");
		// A new subscription starts at the current head. Establish it before
		// waking members; followup() retries while this ask receipt is pending.
		await this.host.messaging.subscribe({
			threadId: input.thread_id,
			includeOwnMessages: false,
		});
		await this.connection.sameAttempt(state);
		await this.connection.authorizeExternal(credential, "ask");
		const result = await this.host.messaging.send({
			threadId: input.thread_id,
			identity: "dot",
			idempotencyKey: `dot-ask:${digest([state.attemptId, input.client_message_id])}`,
			payload,
			wake: "auto",
			meta: { attemptId: state.attemptId },
		});
		await this.connection.sameAttempt(state);
		await this.host.storage.set(key, {
			...reservation,
			messageId: result.messageId,
		});
		await this.connection.sameAttempt(state);
		await this.connection.authorizeExternal(credential, "ask");
		// Re-declare readiness after the receipt is durable. The Host schedules
		// the same cursor, including an earlier receipt-pending delivery.
		await this.host.messaging.subscribe({
			threadId: input.thread_id,
			includeOwnMessages: false,
		});
		return result;
	}
	async restoreSubscriptions() {
		const state = await this.connection.store.connection();
		if (!state || state.revokedAt !== null) return;
		for (const [key, entry] of Object.entries(await this.host.storage.list())) {
			if (!key.startsWith("dot/ask/")) continue;
			const ask = entry.value as {
				attemptId: string;
				threadId: string;
				messageId: string | null;
			};
			if (ask.attemptId === state.attemptId && ask.messageId)
				await this.host.messaging.subscribe({
					threadId: ask.threadId,
					includeOwnMessages: false,
				});
		}
	}
	async followup(input: PluginMessageDelivery) {
		const source = await this.host.messaging.get(input.envelope.messageId);
		const replyTo = source?.replyTo ?? source?.extra?.causal?.triggerMessageId;
		if (!source?.catId || !replyTo) return null;
		const state = await this.connection.store.connection();
		if (!state) return null;
		let awaitingReceipt = false;
		const askRevision = this.askRevision;
		for (const [key, entry] of Object.entries(await this.host.storage.list())) {
			if (!key.startsWith("dot/ask/")) continue;
			const ask = entry.value as {
				attemptId: string;
				threadId: string;
				messageId: string | null;
				recipientCatIds: string[];
			};
			if (
				ask.attemptId === state.attemptId &&
				ask.threadId === source.threadId &&
				ask.recipientCatIds.includes(source.catId)
			) {
				if (ask.messageId === replyTo)
					return this.deliver(input, ask.attemptId);
				if (
					ask.messageId === null &&
					(this.pending.has(key) || askRevision !== this.askRevision)
				)
					awaitingReceipt = true;
			}
		}
		// A rejection retains the Host's durable subscription cursor for replay.
		// Only an active send can still commit a receipt. A failed/interrupted
		// reservation is retained for an explicit idempotent ask retry, but
		// must not indefinitely block unrelated subscription pages. If a send
		// changed while the storage snapshot was read, replay once more to
		// observe its committed receipt rather than acknowledge stale data.
		if (awaitingReceipt) throw new Error("dot_ask_receipt_pending");
		return null;
	}
	/** Finish local proof commits from the already published nonce reply, without sending it again. */
	async resumeVerification(
		id: string,
		verificationKey?: string,
	): Promise<boolean> {
		return this.serial(id, async () => {
			const original = await this.connection.store.dispatch(id);
			if (!original?.connectionTest || !original.replyMessageId) return false;
			if (
				verificationKey !== undefined &&
				original.verificationKey !== verificationKey
			)
				throw new Error("dot_verification_stale");
			const { state, record } = await this.authorize(id, true);
			const reply = await this.host.messaging.get(record.replyMessageId!);
			if (
				!reply ||
				reply.threadId !== record.threadId ||
				reply.replyTo !== record.sourceMessageId ||
				!record.expectedNonce ||
				!reply.content.includes(record.expectedNonce) ||
				!record.replyDigest ||
				digest(reply.content) !== record.replyDigest
			)
				throw new Error("dot_verification_evidence_unavailable");
			await this.connection.sameAttempt(state);
			const pending = (await this.connection.externalState()).pending;
			if (!pending) return true; // The same exact proof has already promoted.
			if (
				pending.verificationEventId !== id ||
				pending.pairingAttemptId !== record.attemptId
			)
				throw new Error("dot_candidate_stale");
			if (
				record.candidateProof &&
				(pending.candidateId !== record.candidateProof.candidateId ||
					pending.tokenId !== record.candidateProof.tokenId ||
					pending.binding?.version !== record.candidateProof.bindingVersion)
			)
				throw new Error("dot_candidate_stale");
			if (!record.candidateProof && pending.binding !== undefined)
				throw new Error("dot_candidate_stale");
			// This credential comes only from our persisted issuance record, never from caller input.
			const credential: VerifiedExternalCredential =
				pending.issuer === "plugin"
					? await this.connection.authenticatePluginToken(pending.token)
					: {
							sub: this.host.pluginInstanceId,
							cap: DOT_EXTERNAL_CAPABILITY_ID,
							jti: pending.tokenId,
							iat: pending.issuedAt,
							exp: pending.expiresAt,
						};
			if (pending.issuer !== "plugin") {
				const inspected = await this.host.capability?.inspectExternal({
					token: pending.token,
					capabilityId: DOT_EXTERNAL_CAPABILITY_ID,
				});
				if (!inspected?.usable)
					throw new Error("dot_external_credential_rejected");
			}
			await this.connection.sameAttempt(state);
			await this.connection.recordPendingEvidence(credential, id, "read");
			await this.connection.recordPendingEvidence(credential, id, "reply");
			return true;
		});
	}
	async testRoundtrip(seed?: {
		nonce: string;
		threadId: string;
		verificationKey: string;
	}) {
		const state = await this.connection.testState(),
			nonce = seed?.nonce ?? randomBytes(8).toString("hex");
		const thread = seed
			? { id: seed.threadId }
			: await this.host.threads.create({ title: "Dot connection test" });
		await this.connection.sameAttempt(state);
		const posted = await this.host.messaging.send({
			threadId: thread.id,
			identity: "dot",
			idempotencyKey: `dot-test:${state.attemptId}:${nonce}`,
			payload: textPayload(`连接测试：请读取原消息，并原样回复 ${nonce}`),
		});
		const source = await this.host.messaging.get(posted.messageId);
		await this.connection.sameAttempt(state);
		if (!source) throw new Error("dot_source_unavailable");
		const execution = `test:${nonce}`,
			id = eventId(state.attemptId, thread.id, source.id, execution);
		await this.connection.store.updateDispatch(
			id,
			(prior) =>
				prior ?? {
					eventId: id,
					ownerUserId: state.ownerUserId,
					threadId: thread.id,
					sourceMessageId: source.id,
					sourceRevision: source.sourceRevision,
					dispatchInvocationId: execution,
					attemptId: state.attemptId,
					agentKeyId: state.agentKeyId,
					occurredAt: this.connection.now(),
					webhookAcknowledgedAt: null,
					sourceReadAt: null,
					replyMessageId: null,
					imagePublicationIds: [],
					connectionTest: true,
					...(state.bindingAuthority?.candidateId
						? {
								candidateProof: {
									candidateId: state.bindingAuthority.candidateId,
									tokenId: state.bindingAuthority.tokenId!,
									bindingVersion: state.bindingAuthority.version!,
								},
							}
						: {}),
					expectedNonce: nonce,
					...(seed ? { verificationKey: seed.verificationKey } : {}),
					deliveryError: null,
				},
		);
		await this.connection.store.updateConnection((current) => {
			this.connection.assertLive();
			if (!current || current.attemptId !== state.attemptId)
				throw new Error("dot_stale_connection");
			return {
				...current,
				revision: current.revision + 1,
				testEventIds: [...new Set([...current.testEventIds, id])].slice(-2),
			};
		});
		const external = await this.connection.externalState();
		if (external.pending && external.pending.verificationEventId !== id)
			await this.connection.bindPendingVerification(id, state);
		const existing = await this.connection.store.dispatch(id);
		if (existing?.replyMessageId) {
			await this.resumeVerification(id, seed?.verificationKey);
			return { eventId: id, nonce, complete: true };
		}
		try {
			await this.sendEvent((await this.connection.store.dispatch(id))!);
			await this.connection.store.updateDispatch(id, (current) => ({
				...current!,
				deliveryError: null,
			}));
			return { eventId: id, nonce, complete: false };
		} catch {
			await this.connection.store.updateDispatch(id, (current) => {
				if (!current) throw new Error("dot_dispatch_missing");
				return { ...current, deliveryError: "dot_delivery_failed" };
			});
			return {
				eventId: id,
				nonce,
				complete: false,
				deliveryError: "dot_delivery_failed",
			};
		}
	}
}
