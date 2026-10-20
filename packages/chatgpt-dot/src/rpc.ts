import { z } from 'zod';
import type { PluginHostActionContext } from '@clowder-ai/plugin-sdk';
import { DotRuntime } from './runtime.js';
import { DOT_EVENT_DEFINITION, DOT_TOOLS, dotEventRefSchema, dotReplyArguments, dotImageArguments, dotAskArguments, dotSubscriptionArguments } from './protocol.js';
const requestSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string().max(128), z.number(), z.null()]).optional(), method: z.string().max(100), params: z.unknown().optional() }).strict();
const subscribeSchema = z.object({ name: z.literal('dot.summoned'), arguments: dotSubscriptionArguments,
    delivery: z.object({ mode: z.literal('webhook'), url: z.string().url().max(2048), secret: z.string().max(256) }).strict(),
    ttlMs: z.number().int().positive().nullable().optional(), cursor: z.null().optional(), _meta: z.record(z.unknown()).optional(), maxAgeMs: z.number().int().nonnegative().optional() }).strict();
const unsubscribeSchema = z.object({ name: z.literal('dot.summoned'), arguments: dotSubscriptionArguments,
    delivery: z.object({ mode: z.literal('webhook'), url: z.string().url().max(2048) }).strict(), cursor: z.null().optional(), _meta: z.record(z.unknown()).optional() }).strict();
const callSchema = z.object({ name: z.string(), arguments: z.unknown(), _meta: z.record(z.unknown()).optional() }).strict();
export const httpRequestSchema = z.object({ request: z.object({ method: z.string(), path: z.string(), query: z.record(z.unknown()).optional(),
        headers: z.record(z.union([z.string(), z.array(z.string())])), body: z.unknown().optional(), rawBody: z.unknown().optional(), principal: z.unknown().optional() }).strict() }).strict();
const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
export async function rpc(runtime: DotRuntime, raw: unknown, context?: PluginHostActionContext) {
    runtime.connection.assertLive();
    const { request } = httpRequestSchema.parse(raw);
    if (request.method !== 'POST' || request.path !== 'mcp')
        throw new Error('dot_mcp_request_rejected');
    let secret: string;
    const candidate = request.headers['x-dot-credential'];
    try {
        if (typeof candidate === 'string') {
            await runtime.connection.authenticate(candidate);
            secret = candidate;
        }
        else {
            // Shared remote relay keeps its principal in Host custody. No bearer or caller body proves identity.
            if (context?.kind !== 'owner-http-request' || context.operation !== 'write')
                throw new Error('dot_owner_required');
            const identity = context.requestIdentity;
            if (identity && (identity.kind !== 'owner_http' || identity.pluginInstanceId !== context.pluginInstanceId || identity.userId !== context.userId || identity.pluginId !== 'official.chatgpt-dot' || identity.contributionId !== 'dot-mcp' || identity.method !== 'POST' || identity.declaredPath !== 'mcp'))
                throw new Error('dot_owner_required');
            await runtime.connection.owner(context);
            const state = await runtime.connection.store.connection();
            if (!state)
                throw new Error('dot_connection_missing');
            secret = state.credentialSecret;
            await runtime.connection.authenticate(secret);
        }
    }
    catch {
        return { status: 403, headers, body: { error: 'dot_credential_rejected' } };
    }
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success)
        return { status: 400, headers, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } } };
    const { id, method, params } = parsed.data;
    if (id === undefined)
        return { status: method === 'notifications/initialized' ? 202 : 400, headers, body: null };
    const complete = (value: object) => ({ status: 200, headers, body: { jsonrpc: '2.0', id, result: { resultType: 'complete', ...value } } });
    try {
        if (method === 'initialize')
            return complete({ protocolVersion: '2026-07-28', capabilities: { tools: {}, events: {} }, serverInfo: { name: 'Clowder AI dot', version: '0.2.0' } });
        if (method === 'server/discover')
            return complete({ supportedVersions: ['2026-07-28'], capabilities: { tools: {}, events: {} } });
        if (method === 'ping')
            return complete({});
        if (method === 'tools/list')
            return complete({ tools: DOT_TOOLS });
        if (method === 'events/list')
            return complete({ events: [DOT_EVENT_DEFINITION] });
        if (method === 'events/subscribe') {
            const input = subscribeSchema.parse(params);
            return complete(await runtime.connection.subscribe(secret, { attemptId: input.arguments.attempt_id, pairingCode: input.arguments.pairing_code,
                url: input.delivery.url, secret: input.delivery.secret, ...input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs } }));
        }
        if (method === 'events/unsubscribe') {
            const input = unsubscribeSchema.parse(params);
            return complete(await runtime.connection.unsubscribe(secret, { attemptId: input.arguments.attempt_id, pairingCode: input.arguments.pairing_code, url: input.delivery.url }));
        }
        if (method !== 'tools/call')
            return { status: 200, headers, body: { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } } };
        const input = callSchema.parse(params);
        let result: unknown;
        switch (input.name) {
            case 'cat_cafe_dot_read_source':
                result = await runtime.read(secret, dotEventRefSchema.parse(input.arguments).event_id);
                break;
            case 'cat_cafe_dot_reply': {
                const args = dotReplyArguments.parse(input.arguments);
                result = await runtime.reply(secret, args.event_id, args.content);
                break;
            }
            case 'cat_cafe_dot_publish_image':
                result = await runtime.image(secret, dotImageArguments.parse(input.arguments));
                break;
            case 'cat_cafe_dot_ask':
                result = await runtime.ask(secret, dotAskArguments.parse(input.arguments));
                break;
            default: return { status: 200, headers, body: { jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown dot tool' } } };
        }
        return complete({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false });
    }
    catch (error) {
        const invalid = error instanceof z.ZodError;
        const reason = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'dot_operation_unavailable';
        return { status: 200, headers, body: { jsonrpc: '2.0', id, error: { code: invalid ? -32602 : /callback|challenge/.test(reason) ? -32015 : -32000,
                    message: invalid ? 'Invalid parameters' : 'Dot operation failed', ...invalid ? {} : { data: { reason } } } } };
    }
}
