import { Readable } from "node:stream";
import { join } from "node:path";
import {
	validateManifest,
	type PluginDeliveryInput,
	type PluginDeliveryReceipt,
} from "@clowder-ai/plugin-contract";
import {
	defineWebhookHandler,
	type ModulePluginHostShape,
	type ModulePluginSettingsHost,
	type PluginActionHandler,
	type PluginHostActionContext,
	type PluginModuleDefinition,
} from "@clowder-ai/plugin-sdk";
import {
	DotConnection,
	type DotSettingsHost,
} from "./connection.js";
import { createDotWebhookSender, type DotWebhookSend } from "./dot-webhook.js";
import { projectDotJourney } from "./journey-projection.js";
import { httpRequestSchema, rpc } from "./rpc.js";
import { DotRuntime, imageReference } from "./runtime.js";
import { TemporaryEndpointController } from "./temporary-endpoint.js";
import type { DotExternalState } from "./external-state.js";
export interface DotPluginOptions {
	readonly sendWebhook?: DotWebhookSend;
	readonly now?: () => number;
}
function longLivedServerUrl(
	template: unknown,
	token: string,
	forwarding: { readonly relativePath: string; readonly method: "POST" },
) {
	if (typeof template !== "string" || template.split("{token}").length !== 2)
		throw new Error("dot_long_lived_template_required");
	const rendered = template.replace("{token}", encodeURIComponent(token));
	const url = new URL(rendered);
	if (url.protocol !== "https:" || url.username || url.password || url.hash)
		throw new Error("dot_long_lived_template_invalid");
	if (forwarding.method !== "POST" || url.pathname !== forwarding.relativePath)
		throw new Error("dot_long_lived_template_route_mismatch");
	return url.toString();
}
function operationInput(params: unknown): Readonly<Record<string, unknown>> {
	if (!params || typeof params !== "object" || Array.isArray(params)) return {};
	const input = (params as { readonly input?: unknown }).input;
	return input && typeof input === "object" && !Array.isArray(input)
		? (input as Readonly<Record<string, unknown>>)
		: {};
}
function endpointCredentialIsLive(state: DotExternalState, now: number): boolean {
	if (state.pending) return state.pending.expiresAt * 1000 > now;
	if (!state.current) return false;
	return state.current.kind === "legacy" || state.current.expiresAt * 1000 > now;
}
export function createDotPlugin(
	options: DotPluginOptions = {},
): PluginModuleDefinition {
	let running: DotRuntime | undefined;
	let temporaryEndpoints: TemporaryEndpointController | undefined;
	async function connection(
		host: DotSettingsHost,
		controller: AbortController,
	) {
		let transport = new AbortController();
		async function configuredSender() {
			const proxy = await host.config.get("webhookProxyUrl");
			if (proxy !== undefined && proxy !== "" && typeof proxy !== "string")
				throw new Error("invalid_dot_proxy_url");
			return (
				options.sendWebhook ??
				createDotWebhookSender(proxy ? String(proxy) : undefined)
			);
		}
		let sender = await configuredSender();
		const send: DotWebhookSend = (url, headers, body, signal, beforeWrite) =>
			sender(
				url,
				headers,
				body,
				AbortSignal.any([
					controller.signal,
					transport.signal,
					...(signal ? [signal] : []),
				]),
				beforeWrite,
			);
		const current = new DotConnection(
			host,
			send,
			controller.signal,
			options.now,
		);
		const refresh = async () => {
			const next = await configuredSender();
			current.assertLive();
			const previous = transport;
			transport = new AbortController();
			sender = next;
			previous.abort(new Error("dot_transport_reconfigured"));
		};
		return [current, refresh] as const;
	}
	const definition: PluginModuleDefinition = {
		async settings(host) {
			const controller = new AbortController(),
				[current] = await connection(host as DotSettingsHost, controller);
			const statusRows = async (context?: PluginHostActionContext) => {
				await current.owner(context);
				const state = await current.store.connection();
				const external = await current.externalState();
				const dispatches = state
					? (await Promise.all(state.testEventIds.map((id) => current.store.dispatch(id)))).filter(
							(value): value is NonNullable<typeof value> => value !== null,
						)
					: [];
				const credentialStatus = external.current
					? await current.inspectCurrentCredential()
					: undefined;
				const now = (options.now ?? Date.now)();
				const connectionMessage = state?.revokedAt === null &&
					(state.pairedAt !== null || state.pairingExpiresAt > now)
					? (await current.instructions(context)).instructions : undefined;
				return {
					render: "rows" as const,
					data: projectDotJourney({
						runtimeRunning: Boolean(running),
						external,
						connection: state,
						dispatches,
						now,
						...(connectionMessage ? { connectionMessage } : {}),
						...(credentialStatus ? { credentialStatus } : {}),
					}),
				};
			};
			const endpointResult = async (context?: PluginHostActionContext) => {
				const connection = await current.begin(context, false);
				return { render: "text" as const, label: await current.serverUrl(), data: connection.instructions };
			};
			const actions: Record<string, PluginActionHandler> = {
				"dot.status": async (_input, _native, context) => statusRows(context),
				"dot.use-long-lived": async (params, _native, context) => {
					await current.owner(context);
					if (!running) throw new Error("dot_runtime_unavailable");
					const existing = await current.externalState();
					if (
						existing.endpoint.mode === "long-lived" &&
						endpointCredentialIsLive(existing, (options.now ?? Date.now)())
					)
						return endpointResult(context);
					const input = operationInput(params);
					const ttlDays = Number(input.externalTokenDays ?? 180);
					const template = input.longLivedServerUrlTemplate;
					const { state, issued } = await current.issuePending(context, ttlDays * 24 * 60 * 60);
					const serverUrl = longLivedServerUrl(template, issued.token, issued.forwarding);
					await current.setLongLivedServerUrl(state.pending!.candidateId, serverUrl);
					return endpointResult(context);
				},
				"dot.start-temporary": async (params, _native, context) => {
					await current.owner(context);
					if (!running || !temporaryEndpoints) throw new Error("dot_runtime_unavailable");
					const before = await current.externalState();
					if (
						before.endpoint.mode === "temporary-active" &&
						before.endpoint.expiresAt > (options.now ?? Date.now)() &&
						endpointCredentialIsLive(before, (options.now ?? Date.now)())
					)
						return endpointResult(context);
					const hours = Number(operationInput(params).temporaryEndpointHours ?? 1);
					if (!Number.isFinite(hours) || hours <= 0 || hours > 24)
						throw new Error("dot_temporary_ttl_invalid");
					const ttlMs = Math.floor(hours * 60 * 60_000);
					const { state, issued } = await current.issuePending(context, Math.ceil(ttlMs / 1000) + 300);
					const existing = await current.externalState();
					const lease = existing.endpoint.mode === "temporary-active" && existing.endpoint.expiresAt > (options.now ?? Date.now)()
						? temporaryEndpoints.allowToken(issued.token)
						: await temporaryEndpoints.start({ ...issued.forwarding, token: issued.token, ttlMs });
					await current.setTemporaryLease(state.pending!.candidateId, lease);
					return endpointResult(context);
				},
				"dot.refresh-credential": async (params, _native, context) => {
					await current.owner(context);
					if (!running) throw new Error("dot_runtime_unavailable");
					const before = await current.externalState();
					const input = operationInput(params);
					const ttlDays = Number(input.externalTokenDays ?? 180);
					const { state, issued } = await current.issuePending(context, ttlDays * 24 * 60 * 60);
					const candidateId = state.pending!.candidateId;
					if (before.endpoint.mode === "long-lived") {
						const template = input.longLivedServerUrlTemplate;
						const serverUrl = longLivedServerUrl(template, issued.token, issued.forwarding);
						await current.setLongLivedServerUrl(candidateId, serverUrl);
						return { render: "text", data: serverUrl };
					}
					if (before.endpoint.mode === "temporary-active" && before.endpoint.expiresAt > (options.now ?? Date.now)()) {
						if (!temporaryEndpoints) throw new Error("dot_temporary_endpoint_unavailable");
						const lease = temporaryEndpoints.allowToken(issued.token);
						await current.setTemporaryLease(candidateId, lease);
						return { render: "text", data: lease.serverUrl };
					}
					await current.cancelPending();
					throw new Error("dot_endpoint_unavailable");
				},
				"dot.show-server-url": async (_input, _native, context) => {
					await current.owner(context);
					return { render: "text", data: await current.serverUrl() };
				},
				"dot.cancel-pending": async (_input, _native, context) => {
					await current.owner(context);
					const before = await current.externalState();
					const restored = await current.cancelPending();
					if (
						before.endpoint.mode === "temporary-active" &&
						(restored.endpoint.mode !== "temporary-active" ||
							restored.endpoint.generation !== before.endpoint.generation)
					)
						await temporaryEndpoints?.stop("owner_stop");
					return statusRows(context);
				},
				"dot.begin-pairing": async (_input, _native, context) => {
					await current.begin(context, false);
					return statusRows(context);
				},
				"dot.show-instructions": async (_input, _native, context) => ({
					render: "text",
					data: (await current.begin(context, false)).instructions,
				}),
				"dot.reconnect": async (_input, _native, context) => {
					await current.begin(context, true);
					return statusRows(context);
				},
				"dot.roundtrip": async (_input, _native, context) => {
					if (!running) throw new Error("dot_runtime_unavailable");
					await running.testRoundtrip();
					return statusRows(context);
				},
				"dot.check-roundtrip": async (_input, _native, context) => statusRows(context),
				"dot.disconnect": async (_input, _native, context) => {
					await temporaryEndpoints?.stop("owner_stop");
					await current.revokeExternal();
					if (await current.store.connection()) await current.disconnect(context);
					return statusRows(context);
				},
			};
			const guarded = Object.fromEntries(
				Object.entries(actions).map(([method, handler]) => [
					method,
					async (
						input: unknown,
						native?: Parameters<PluginActionHandler>[1],
						context?: PluginHostActionContext,
					) => {
						current.assertLive();
						const fenced = context
							? {
									...context,
									signal: AbortSignal.any([context.signal, controller.signal]),
									assertCurrent: async () => {
										current.assertLive();
										await context.assertCurrent();
										current.assertLive();
									},
								}
							: undefined;
						return current.within(fenced, async () => {
							await current.assertCurrent();
							const result = await handler(input, native, fenced);
							await current.assertCurrent();
							return result;
						});
					},
				]),
			);
			return {
				actions: guarded,
				dispose() {
					controller.abort(new Error("dot_settings_revoked"));
				},
			};
		},
		async start(host: ModulePluginHostShape) {
			if (running) throw new Error("dot_already_running");
			const controller = new AbortController(),
				dotHost = host as ModulePluginHostShape & DotSettingsHost,
				[current, refresh] = await connection(dotHost, controller),
				runtime = new DotRuntime(host, current);
				temporaryEndpoints = new TemporaryEndpointController({
					...(options.now ? { now: options.now } : {}),
					runtimeDirectory: join(dotHost.dataPath, "temporary-endpoint"),
					onEnded: async (generation) => {
						try { await current.expireTemporary(generation); }
						catch { /* A newer exact lease owns the page now. */ }
					},
				});
			running = runtime;
			let disposeSettings: (() => void | Promise<void>) | undefined;
			try {
				const external = await current.externalState();
				if (external.endpoint.mode === "temporary-active")
					await current.expireTemporary(external.endpoint.generation);
				await runtime.restoreSubscriptions();
				let stop: Promise<void> | undefined;
				const admitted = new Set<Promise<unknown>>();
				const deliver = async (input: PluginDeliveryInput): Promise<PluginDeliveryReceipt> => {
					current.assertLive();
					if (input.kind !== "message") return { deliveryId: input.deliveryId };
					if (input.reason === "subscription") {
						return (await runtime.followup(input)) ?? { deliveryId: input.deliveryId };
					}
					return runtime.deliver(input);
				};
				const handle = async (request: Readonly<Record<string, unknown>>) => {
					current.assertLive();
					const task = current.within(undefined, async () => {
						await current.assertCurrent();
						const result = await rpc(runtime, request);
						await current.assertCurrent();
						return result;
					});
					admitted.add(task);
					try { return await task; } finally { admitted.delete(task); }
				};
				const actions: Record<string, PluginActionHandler> = {
					"dot.test": async (_input, _native, context) => {
						await current.owner(context);
						const state = await current.store.connection();
						if (!state)
							return { ok: false, message: "先在连接设置中准备配对。" };
						let ready = null;
						try {
							ready = await current.ready();
						} catch {
							// Historical evidence remains inspectable below, but cannot make this attempt ready.
						}
							const credential = await current.inspectCurrentCredential();
						const tests = await Promise.all(
							state.testEventIds.map((id) => current.store.dispatch(id)),
						);
						const currentReady =
								ready?.attemptId === state.attemptId && credential.usable;
						const ok = Boolean(
							currentReady &&
								tests.some(
									(record) =>
										record?.attemptId === state.attemptId &&
										record.sourceReadAt !== null &&
										record.replyMessageId,
								),
						);
						return {
							ok,
							message: ok
								? "已确认读取原消息并回复。"
								: "尚未完成真实往返测试。",
							details: { ...current.project(state), live: "running" },
						};
					},
					"dot.roundtrip": async (_input, _native, context) => {
						await current.owner(context);
						const state = await current.store.connection();
						if (!state) throw new Error("dot_connection_missing");
						return {
							render: "text",
							data: await runtime.testRoundtrip(),
						};
					},
				};
				// Settings actions exist in the stopped Manager path and the active action table.
				const settings = await definition.settings!(dotHost);
				disposeSettings = () => settings.dispose?.();
				Object.assign(actions, settings.actions);
				const webhook = defineWebhookHandler(
					async ({ contributionId, request: raw }, context) => {
						current.assertLive();
						const task = current.within(context, async () => {
							await current.assertCurrent();
							let result: unknown;
							if (contributionId === "dot-original") {
								const { request } = httpRequestSchema.parse({ request: raw });
								if (
									request.method !== "GET" ||
									!/^images\/dot_img_[a-f0-9]{64}$/.test(request.path)
								)
									throw new Error("dot_image_access_denied");
								await current.owner(context);
								const reference = imageReference(
									request.path.slice("images/".length),
								);
								result = {
									status: 200,
									headers: {
										"content-type": "image/png",
										"cache-control": "private, no-store",
										"x-content-type-options": "nosniff",
									},
									body: Readable.from(
										runtime.streams.read(reference, {
											signal: context!.signal,
										}),
									),
								};
							} else {
								throw new Error("webhook_contribution_not_declared");
							}
							await current.assertCurrent();
							return result;
						});
						admitted.add(task);
						try {
							return await task;
						} finally {
							admitted.delete(task);
						}
					},
				);
				const guarded = Object.fromEntries(
					Object.entries(actions).map(([method, handler]) => [
						method,
						async (
							input: unknown,
							native?: Parameters<PluginActionHandler>[1],
							context?: PluginHostActionContext,
						) => {
							current.assertLive();
							const task = current.within(context, async () => {
								await current.assertCurrent();
								const result = await handler(input, native, context);
								await current.assertCurrent();
								return result;
							});
							admitted.add(task);
							try {
								return await task;
							} finally {
								admitted.delete(task);
							}
						},
					]),
				);
				return {
					actions: guarded,
					deliver,
					handle,
					webhook,
					streams: runtime.streams,
					configRefresh: refresh,
					stop() {
						stop ??= (async () => {
							controller.abort(new Error("dot_stopped"));
							await temporaryEndpoints?.stop("owner_stop");
							await settings.dispose?.();
							await Promise.allSettled([...admitted]);
							await runtime.settle();
							if (running === runtime) running = undefined;
							if (running === undefined) temporaryEndpoints = undefined;
						})();
						return stop;
					},
				};
			} catch (error) {
				controller.abort(error);
				await Promise.allSettled([
					temporaryEndpoints?.stop("startup_failed") ?? Promise.resolve(),
					Promise.resolve().then(() => disposeSettings?.()),
					runtime.settle(),
				]);
				if (running === runtime) running = undefined;
				throw error;
			}
		},
		async uninstall() {},
	};
	return definition;
}
export default {
	create(raw: unknown) {
		const checked = validateManifest(raw);
		if (
			!checked.valid ||
			checked.manifest.pluginId !== "official.chatgpt-dot" ||
			checked.manifest.call?.alias !== "dot"
		)
			throw new Error("invalid_dot_manifest");
		return createDotPlugin();
	},
};
