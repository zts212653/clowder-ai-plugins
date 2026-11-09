import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { DotRuntime } from "./runtime.js";
import { digest } from "./store.js";

const jobSchema = z
	.object({
		v: z.literal(1),
		key: z.string(),
		nonce: z.string(),
		stage: z.enum(["queued", "creating-thread", "running", "sent", "failed"]),
		attempts: z.number().int().nonnegative(),
		threadId: z.string().optional(),
		eventId: z.string().optional(),
		error: z.string().optional(),
	})
	.strict();
export type VerificationJob = z.infer<typeof jobSchema>;

/** One activation-owned timer and one durable job per actual authorization/callback binding. */
export class AutomaticDotVerification {
	private timer?: ReturnType<typeof setTimeout>;
	private active?: Promise<void>;
	constructor(
		readonly runtime: DotRuntime,
		readonly delayMs = 1000,
	) {
		runtime.connection.signal.addEventListener("abort", () => this.stop(), {
			once: true,
		});
	}
	private async identity() {
		const { connection } = this.runtime;
		const external = await connection.externalState();
		if (
			external.endpoint.mode === "absent" ||
			external.endpoint.mode === "temporary-expired" ||
			(external.endpoint.mode === "temporary-active" &&
				external.endpoint.expiresAt <= connection.now())
		)
			return null;
		const state = await connection.testState(),
			subscription = state.subscription!;
		const key = digest([
			this.runtime.host.pluginInstanceId,
			state.attemptId,
			state.bindingAuthority?.tokenId ?? "legacy",
			subscription.id,
			subscription.url,
			subscription.secret,
		]);
		return { state, key };
	}
	private async job(key: string) {
		const entry = await this.runtime.host.storage.get(
			`dot/verification/${key}`,
		);
		return entry ? jobSchema.parse(entry.value) : null;
	}
	private update(
		key: string,
		change: (job: VerificationJob | null) => VerificationJob,
	) {
		return this.runtime.connection.store.update(
			`dot/verification/${key}`,
			jobSchema,
			change,
		);
	}
	async status(): Promise<VerificationJob | undefined> {
		try {
			const identity = await this.identity();
			if (!identity) return undefined;
			const job = await this.job(identity.key);
			return job ?? undefined;
		} catch {
			return undefined;
		}
	}
	schedule(delay = this.delayMs) {
		if (this.runtime.connection.signal.aborted) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.active) {
				this.schedule();
				return;
			}
			const task = this.runtime.connection
				.within(undefined, () => this.run())
				.catch(() => {
					this.runtime.host.log?.(
						"warn",
						"dot_automatic_verification_unavailable",
					);
				});
			this.active = task;
			void task.finally(() => {
				if (this.active === task) this.active = undefined;
			});
		}, delay);
		this.timer.unref?.();
	}
	stop() {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}
	async settle() {
		await this.active;
	}
	async retry() {
		const identity = await this.identity();
		if (!identity) throw new Error("dot_endpoint_unavailable");
		const job = await this.job(identity.key);
		if (job)
			await this.update(identity.key, (current) => ({
				...current!,
				stage: "queued",
				attempts: 0,
				error: undefined,
			}));
		this.schedule(0);
	}
	private async run() {
		let identity: Awaited<ReturnType<AutomaticDotVerification["identity"]>>;
		try {
			identity = await this.identity();
		} catch {
			return;
		}
		if (!identity) return;
		const { key } = identity;
		// Existing successful evidence is authoritative across restarts; do not recreate its job.
		const external = await this.runtime.connection.externalState();
		if (
			!external.pending &&
			external.current &&
			external.current.kind !== "legacy" &&
			external.current.verifiedEventId
		) {
			const proof = await this.runtime.connection.store.dispatch(
				external.current.verifiedEventId,
			);
			if (
				proof?.replyMessageId &&
				proof.sourceReadAt !== null &&
				proof.verificationKey === key
			)
				return;
		}
		const nonce = randomBytes(8).toString("hex");
		let job = await this.update(
			key,
			(current) =>
				current ?? { v: 1, key, nonce, stage: "queued", attempts: 0 },
		);
		if (job.stage === "creating-thread" && !job.threadId) {
			await this.update(key, (current) => ({
				...current!,
				stage: "failed",
				error: "dot_verification_creation_unknown",
			}));
			return;
		}
		const assertIdentity = async () => {
			const now = await this.identity();
			if (!now || now.key !== key) throw new Error("dot_verification_stale");
			await this.runtime.connection.assertCurrent();
		};
		try {
			await assertIdentity();
			if (
				job.eventId &&
				(await this.runtime.resumeVerification(job.eventId, key))
			)
				return;
			if (job.stage === "failed" || (job.stage === "sent" && job.eventId))
				return;
			if (!job.threadId) {
				await assertIdentity();
				job = await this.update(key, (current) => ({
					...current!,
					stage: "creating-thread",
				}));
				const thread = await this.runtime.host.threads.create({
					title: "Dot connection test",
				});
				await assertIdentity();
				job = await this.update(key, (current) => ({
					...current!,
					threadId: thread.id,
					stage: "running",
				}));
			}
			await assertIdentity();
			const result = await this.runtime.testRoundtrip({
				nonce: job.nonce,
				threadId: job.threadId!,
				verificationKey: key,
			});
			await assertIdentity();
			job = await this.update(key, (current) => ({
				...current!,
				eventId: result.eventId,
				stage: result.deliveryError ? "running" : "sent",
				attempts: current!.attempts + 1,
				error: result.deliveryError,
			}));
			if (result.deliveryError) {
				if (job.attempts < 3)
					this.schedule(this.delayMs * Math.pow(2, job.attempts));
				else
					await this.update(key, (current) => ({
						...current!,
						stage: "failed",
					}));
			}
		} catch (error) {
			this.runtime.connection.assertLive();
			const reason =
				job.stage === "creating-thread" && !job.threadId
					? "dot_verification_creation_unknown"
					: error instanceof Error && /^dot_[a-z_]+$/.test(error.message)
						? error.message
						: "dot_verification_failed";
			await this.update(key, (current) => ({
				...current!,
				stage: "failed",
				error: reason,
			}));
		}
	}
}
