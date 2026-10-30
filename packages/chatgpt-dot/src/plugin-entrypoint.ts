import { Readable } from "node:stream";
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
import { DotConnection, type DotSettingsHost } from "./connection.js";
import { createDotWebhookSender, type DotWebhookSend } from "./dot-webhook.js";
import { httpRequestSchema, rpc } from "./rpc.js";
import { DotRuntime, imageReference } from "./runtime.js";
export interface DotPluginOptions {
	readonly sendWebhook?: DotWebhookSend;
	readonly now?: () => number;
}
export function createDotPlugin(
	options: DotPluginOptions = {},
): PluginModuleDefinition {
	let running: DotRuntime | undefined;
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
			const actions: Record<string, PluginActionHandler> = {
				"dot.begin": async (_input, _native, context) => ({
					render: "text",
					// Host supplies configuration/operation metadata here. Preparing is
					// idempotent; only the separately confirmed reconnect action rotates it.
					data: await current.begin(context),
				}),
				"dot.reconnect": async (_input, _native, context) => ({
					render: "text",
					data: await current.begin(context, true),
				}),
				"dot.disconnect": async (_input, _native, context) => ({
					render: "text",
					data: await current.disconnect(context),
				}),
				"dot.status": async (_input, _native, context) => {
					await current.owner(context);
					const state = await current.store.connection();
					return {
						render: "text",
						data: {
							...current.project(state),
							live: running ? "running" : "unobserved",
						},
					};
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
			running = runtime;
			let disposeSettings: (() => void | Promise<void>) | undefined;
			try {
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
						const tests = await Promise.all(
							state.testEventIds.map((id) => current.store.dispatch(id)),
						);
						const ok = tests.some(
							(record) =>
								record?.sourceReadAt !== null && record?.replyMessageId,
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
							await settings.dispose?.();
							await Promise.allSettled([...admitted]);
							await runtime.settle();
							if (running === runtime) running = undefined;
						})();
						return stop;
					},
				};
			} catch (error) {
				controller.abort(error);
				await Promise.allSettled([
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
