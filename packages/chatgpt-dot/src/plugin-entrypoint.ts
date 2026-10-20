import { defineDeliveryAction, type ModulePluginHostShape, type ModulePluginSettingsHost, type PluginHostActionContext, type PluginActionHandler, type PluginModuleDefinition } from '@clowder-ai/plugin-sdk';
import { validateManifest } from '@clowder-ai/plugin-contract';
import { z } from 'zod';
import { DotConnection } from './connection.js';
import { DotRuntime, imageReference } from './runtime.js';
import { Readable } from 'node:stream';
import { rpc, httpRequestSchema } from './rpc.js';
import { createDotWebhookSender, type DotWebhookSend } from './dot-webhook.js';
import { importLegacyBatch } from './migration.js';
export interface DotPluginOptions {
    readonly sendWebhook?: DotWebhookSend;
    readonly now?: () => number;
}
const beginInput = z.object({ reconnect: z.boolean().optional() }).strict();
export function createDotPlugin(options: DotPluginOptions = {}): PluginModuleDefinition {
    let running: DotRuntime | undefined;
    async function connection(host: ModulePluginSettingsHost, controller: AbortController) {
        let transport = new AbortController();
        async function configuredSender() {
            const proxy = await host.config.get('webhookProxyUrl');
            if (proxy !== undefined && proxy !== '' && typeof proxy !== 'string')
                throw new Error('invalid_dot_proxy_url');
            return options.sendWebhook ?? createDotWebhookSender(proxy ? String(proxy) : undefined);
        }
        let sender = await configuredSender();
        const send: DotWebhookSend = (url, headers, body, signal) => sender(url, headers, body, AbortSignal.any([
            controller.signal, transport.signal, ...signal ? [signal] : [],
        ]));
        const current = new DotConnection(host, send, controller.signal, options.now);
        const refresh = async () => {
            const next = await configuredSender();
            current.assertLive();
            const previous = transport;
            transport = new AbortController();
            sender = next;
            previous.abort(new Error('dot_transport_reconfigured'));
        };
        return [current, refresh] as const;
    }
    const definition: PluginModuleDefinition = {
        async settings(host) {
            const controller = new AbortController(), [current] = await connection(host, controller);
            const actions: Record<string, PluginActionHandler> = {
                'dot.begin': async (input, _native, context) => ({ render: 'text', data: await current.begin(context, beginInput.parse(input ?? {}).reconnect ?? false) }),
                'dot.reconnect': async (_input, _native, context) => ({ render: 'text', data: await current.begin(context, true) }),
                'dot.disconnect': async (_input, _native, context) => ({ render: 'text', data: await current.disconnect(context) }),
                'dot.status': async (_input, _native, context) => {
                    await current.owner(context);
                    const state = await current.store.connection();
                    return { render: 'text', data: { ...current.project(state), live: running ? 'running' : 'unobserved' } };
                },
                'dot.import': async (input, _native, context) => ({ render: 'text', data: await importLegacyBatch(host, input, context) }),
            };
            const guarded = Object.fromEntries(Object.entries(actions).map(([method, handler]) => [method,
                async (input: unknown, native?: Parameters<PluginActionHandler>[1], context?: PluginHostActionContext) => {
                    current.assertLive();
                    const fenced = context ? {...context,
                        signal: AbortSignal.any([context.signal, controller.signal]),
                        assertCurrent: async () => { current.assertLive(); await context.assertCurrent(); current.assertLive(); },
                    } : undefined;
                    return current.within(fenced, async () => {
                        await current.assertCurrent();
                        const result = await handler(input, native, fenced);
                        await current.assertCurrent();
                        return result;
                    });
                },
            ]));
            return { actions: guarded, dispose() { controller.abort(new Error('dot_settings_revoked')); } };
        },
        async start(host: ModulePluginHostShape) {
            if (running)
                throw new Error('dot_already_running');
            const controller = new AbortController(), [current, refresh] = await connection(host, controller), runtime = new DotRuntime(host, current);
            running = runtime;
            let disposeSettings: (() => void | Promise<void>) | undefined;
            try {
                await runtime.restoreSubscriptions();
                let stop: Promise<void> | undefined;
                const delivery = defineDeliveryAction(async (input) => {
                    current.assertLive();
                    if (input.kind !== 'message')
                        throw new Error('dot_requires_message_delivery');
                    return runtime.deliver(input);
                });
                const actions: Record<string, PluginActionHandler> = {
                    deliverMessage: delivery,
                    'dot.followup': defineDeliveryAction(async (input) => {
                        current.assertLive();
                        return input.kind === 'message' ? runtime.followup(input) : { deliveryId: input.deliveryId };
                    }),
                    'dot.rpc': (input, _native, context) => rpc(runtime, input, context),
                    'dot.test': async (_input, _native, context) => {
                        await current.owner(context);
                        const state = await current.store.connection();
                        if (!state)
                            return { ok: false, message: '先在连接设置中准备配对。' };
                        const tests = await Promise.all(state.testEventIds.map(id => current.store.dispatch(id)));
                        const ok = tests.some(record => record?.sourceReadAt !== null && record?.replyMessageId);
                        return { ok, message: ok ? '已确认读取原消息并回复。' : '尚未完成真实往返测试。', details: { ...current.project(state), live: 'running' } };
                    },
                    'dot.roundtrip': async (_input, _native, context) => {
                        await current.owner(context);
                        const state = await current.store.connection();
                        if (!state)
                            throw new Error('dot_connection_missing');
                        return { render: 'text', data: await runtime.testRoundtrip(state.credentialSecret) };
                    },
                    'dot.image': async (raw, _native, context) => {
                        const { request } = httpRequestSchema.parse(raw);
                        if (request.method !== 'GET' || !/^images\/dot_img_[a-f0-9]{64}$/.test(request.path))
                            throw new Error('dot_image_access_denied');
                        await current.owner(context);
                        const reference = imageReference(request.path.slice('images/'.length));
                        return { status: 200, headers: { 'content-type': 'image/png', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
                            body: Readable.from(runtime.streams.read(reference, {signal: context!.signal})) };
                    },
                };
                // Settings actions exist in the stopped Manager path and the active action table.
                const settings = await definition.settings!(host);
                disposeSettings = () => settings.dispose?.();
                const {['dot.import']: migrationOnly, ...liveSettings} = settings.actions;
                Object.assign(actions, liveSettings);
                const admitted = new Set<Promise<unknown>>();
                const guarded = Object.fromEntries(Object.entries(actions).map(([method, handler]) => [method,
                    async (input: unknown, native?: Parameters<PluginActionHandler>[1], context?: PluginHostActionContext) => {
                        current.assertLive();
                        const task = current.within(context, async () => {
                            await current.assertCurrent();
                            const result = await handler(input, native, context);
                            await current.assertCurrent();
                            return result;
                        });
                        admitted.add(task);
                        try { return await task; }
                        finally { admitted.delete(task); }
                    },
                ]));
                return { actions: guarded, streams: runtime.streams, configRefresh: refresh, stop() {
                        stop ??= (async () => { controller.abort(new Error('dot_stopped')); await settings.dispose?.(); await Promise.allSettled([...admitted]); await runtime.settle(); if (running === runtime)
                            running = undefined; })();
                        return stop;
                    } };
            }
            catch (error) {
                controller.abort(error);
                await Promise.allSettled([Promise.resolve().then(() => disposeSettings?.()), runtime.settle()]);
                if (running === runtime)
                    running = undefined;
                throw error;
            }
        },
        async uninstall() { },
    };
    return definition;
}
export default { create(raw: unknown) {
        const checked = validateManifest(raw);
        if (!checked.valid || checked.manifest.pluginId !== 'official.chatgpt-dot' || checked.manifest.addressedDelivery?.method !== 'deliverMessage')
            throw new Error('invalid_dot_manifest');
        return createDotPlugin();
    } };
