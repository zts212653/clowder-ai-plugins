import { z } from 'zod';
import { DotRuntime } from './runtime.js';
import { DOT_EVENT_DEFINITION, DOT_TOOLS, dotEventRefSchema, dotReplyArguments, dotImageArguments, dotAskArguments, dotSubscriptionArguments } from './protocol.js';
import type { VerifiedExternalCredential } from './external-state.js';
const requestSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string().max(128), z.number(), z.null()]).optional(), method: z.string().max(100), params: z.unknown().optional() }).strict();
const subscribeSchema = z.object({ name: z.literal('dot.summoned'), arguments: dotSubscriptionArguments,
    delivery: z.object({ mode: z.literal('webhook'), url: z.string().url().max(2048), secret: z.string().max(256) }).strict(),
    ttlMs: z.number().int().positive().nullable().optional(), cursor: z.null().optional(), _meta: z.record(z.unknown()).optional(), maxAgeMs: z.number().int().nonnegative().optional() }).strict();
const unsubscribeSchema = z.object({ name: z.literal('dot.summoned'), arguments: dotSubscriptionArguments,
    delivery: z.object({ mode: z.literal('webhook'), url: z.string().url().max(2048) }).strict(), cursor: z.null().optional(), _meta: z.record(z.unknown()).optional() }).strict();
const callSchema = z.object({ name: z.string(), arguments: z.unknown(), _meta: z.record(z.unknown()).optional() }).strict();
const initializeSchema = z.object({
    protocolVersion: z.string(), capabilities: z.record(z.unknown()),
    clientInfo: z.object({ name: z.string(), version: z.string() }).passthrough(),
}).passthrough();
const LEGACY_PROTOCOL_VERSIONS = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
const MODERN_PROTOCOL_VERSION = '2026-07-28';
const serverInfo = { name: 'Clowder AI dot', version: '0.2.0' };
export const httpRequestSchema = z.object({ request: z.object({ method: z.string(), path: z.string(), query: z.record(z.unknown()).optional(),
        headers: z.record(z.union([z.string(), z.array(z.string())])), body: z.unknown().optional(), rawBody: z.unknown().optional(), principal: z.unknown().optional() }).strict() }).strict();
const externalRequestSchema = z.object({
    method: z.string(),
    headers: z.record(z.union([z.string(), z.array(z.string())])),
    body: z.unknown().optional(),
    credential: z.object({ sub: z.string(), cap: z.string(), jti: z.string(), iat: z.number(), exp: z.number() }).strict().optional(),
}).strict();
const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
export async function rpc(runtime: DotRuntime, raw: unknown) {
    runtime.connection.assertLive();
    const request = externalRequestSchema.parse(raw);
    if (request.method !== 'POST')
        throw new Error('dot_mcp_request_rejected');
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success)
        return { status: 400, headers, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } } };
    const { id, method, params } = parsed.data;
    const eventRpc = ['events/list', 'events/subscribe', 'events/unsubscribe'].includes(method);
    if (eventRpc) runtime.connection.host.log?.('info', 'dot_event_rpc_received', { method });
    const credential = request.credential as VerifiedExternalCredential | undefined;
    if (id === undefined)
        return { status: method === 'notifications/initialized' ? 202 : 400, headers, body: null };
    const protocolHeader = Object.entries(request.headers).find(([name]) => name.toLowerCase() === 'mcp-protocol-version')?.[1];
    const requestMeta = params && typeof params === 'object' && !Array.isArray(params) && '_meta' in params
        ? (params as { _meta?: unknown })._meta : undefined;
    const metaProtocol = requestMeta && typeof requestMeta === 'object' && !Array.isArray(requestMeta)
        ? (requestMeta as Record<string, unknown>)['io.modelcontextprotocol/protocolVersion'] : undefined;
    const modern = method === 'server/discover' || protocolHeader === MODERN_PROTOCOL_VERSION || metaProtocol === MODERN_PROTOCOL_VERSION;
    const complete = async (value: object) => {
        const current = (await runtime.connection.externalState()).current;
        const retireLegacy = credential && current?.kind === 'signed' && current.tokenId === credential.jti;
        const result = modern ? {
            resultType: 'complete',
            ...value,
            _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
        } : value;
        return {
            status: 200,
            headers,
            body: { jsonrpc: '2.0', id, result },
            ...(retireLegacy ? {
                hostEffects: { retireLegacyCredential: { tokenId: credential.jti } },
            } : {}),
        };
    };
    try {
        if (['initialize', 'server/discover', 'tools/list', 'events/list'].includes(method))
            await runtime.connection.recordDiscovery(credential);
        if (method === 'initialize') {
            const input = initializeSchema.parse(params);
            const protocolVersion = LEGACY_PROTOCOL_VERSIONS.has(input.protocolVersion) ? input.protocolVersion : '2025-11-25';
            return complete({ protocolVersion, capabilities: { tools: {}, events: {} }, serverInfo });
        }
        if (method === 'server/discover')
            return complete({ supportedVersions: [MODERN_PROTOCOL_VERSION], capabilities: { tools: {}, events: {} } });
        if (method === 'ping')
            return complete({});
        if (method === 'tools/list')
            return complete({ tools: DOT_TOOLS });
        if (method === 'events/list')
            return complete({ events: [DOT_EVENT_DEFINITION] });
        if (method !== 'tools/call' && method !== 'events/subscribe' && method !== 'events/unsubscribe')
            return { status: 200, headers, body: { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } } };
        try { await runtime.connection.current(); }
        catch {
            if (eventRpc) runtime.connection.host.log?.('warn', 'dot_event_rpc_failed', { method, code: 409, reason: 'dot_connection_unavailable' });
            return { status: 409, headers, body: { error: 'dot_connection_unavailable' } };
        }
        if (method === 'events/subscribe') {
            await runtime.connection.authorizeExternal(credential, 'pairing-subscribe');
            const input = subscribeSchema.parse(params);
            return complete(await runtime.connection.subscribe({ attemptId: input.arguments.attempt_id, pairingCode: input.arguments.pairing_code,
                url: input.delivery.url, secret: input.delivery.secret, ...input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs } }));
        }
        if (method === 'events/unsubscribe') {
            await runtime.connection.authorizeExternal(credential, 'pairing-unsubscribe');
            const input = unsubscribeSchema.parse(params);
            return complete(await runtime.connection.unsubscribe({ attemptId: input.arguments.attempt_id, pairingCode: input.arguments.pairing_code, url: input.delivery.url }));
        }
        const input = callSchema.parse(params);
        let result: unknown;
        switch (input.name) {
            case 'cat_cafe_dot_read_source':
                {
                    const eventId = dotEventRefSchema.parse(input.arguments).event_id;
                    await runtime.connection.authorizeExternal(credential, 'read', eventId);
                    result = await runtime.read(eventId, credential);
                }
                break;
            case 'cat_cafe_dot_reply': {
                const args = dotReplyArguments.parse(input.arguments);
                await runtime.connection.authorizeExternal(credential, 'reply', args.event_id);
                result = await runtime.reply(args.event_id, args.content, credential);
                break;
            }
            case 'cat_cafe_dot_publish_image':
                await runtime.connection.authorizeExternal(credential, 'publish-image', dotImageArguments.parse(input.arguments).event_id);
                result = await runtime.image(dotImageArguments.parse(input.arguments));
                break;
            case 'cat_cafe_dot_ask':
                await runtime.connection.authorizeExternal(credential, 'ask');
                result = await runtime.ask(dotAskArguments.parse(input.arguments));
                break;
            default: return { status: 200, headers, body: { jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown dot tool' } } };
        }
        return complete({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false });
    }
    catch (error) {
        const invalid = error instanceof z.ZodError;
        const reason = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'dot_operation_unavailable';
        const code = invalid ? -32602 : /callback|challenge/.test(reason) ? -32015 : -32000;
        if (eventRpc) runtime.connection.host.log?.('warn', 'dot_event_rpc_failed', { method, code, reason: invalid ? 'invalid_parameters' : reason });
        return { status: 200, headers, body: { jsonrpc: '2.0', id, error: { code,
                    message: invalid ? 'Invalid parameters' : 'Dot operation failed', ...invalid ? {} : { data: { reason } } } } };
    }
}
