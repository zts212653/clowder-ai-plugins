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
    const credential = request.credential as VerifiedExternalCredential | undefined;
    if (id === undefined)
        return { status: method === 'notifications/initialized' ? 202 : 400, headers, body: null };
    const complete = (value: object) => ({ status: 200, headers, body: { jsonrpc: '2.0', id, result: { resultType: 'complete', ...value } } });
    try {
        if (['initialize', 'server/discover', 'tools/list', 'events/list'].includes(method))
            await runtime.connection.recordDiscovery(credential);
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
        if (method !== 'tools/call' && method !== 'events/subscribe' && method !== 'events/unsubscribe')
            return { status: 200, headers, body: { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } } };
        try { await runtime.connection.current(); }
        catch { return { status: 409, headers, body: { error: 'dot_connection_unavailable' } }; }
        if (method === 'events/subscribe') {
            await runtime.connection.authorizeExternal(credential, 'pairing');
            const input = subscribeSchema.parse(params);
            return complete(await runtime.connection.subscribe({ attemptId: input.arguments.attempt_id, pairingCode: input.arguments.pairing_code,
                url: input.delivery.url, secret: input.delivery.secret, ...input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs } }));
        }
        if (method === 'events/unsubscribe') {
            await runtime.connection.authorizeExternal(credential, 'pairing');
            const input = unsubscribeSchema.parse(params);
            return complete(await runtime.connection.unsubscribe({ attemptId: input.arguments.attempt_id, pairingCode: input.arguments.pairing_code, url: input.delivery.url }));
        }
        const input = callSchema.parse(params);
        let result: unknown;
        switch (input.name) {
            case 'cat_cafe_dot_read_source':
                {
                    const eventId = dotEventRefSchema.parse(input.arguments).event_id;
                    await runtime.connection.authorizeExternal(credential, 'business', eventId);
                    result = await runtime.read(eventId, credential);
                }
                break;
            case 'cat_cafe_dot_reply': {
                const args = dotReplyArguments.parse(input.arguments);
                await runtime.connection.authorizeExternal(credential, 'business', args.event_id);
                result = await runtime.reply(args.event_id, args.content, credential);
                break;
            }
            case 'cat_cafe_dot_publish_image':
                await runtime.connection.authorizeExternal(credential, 'business', dotImageArguments.parse(input.arguments).event_id);
                result = await runtime.image(dotImageArguments.parse(input.arguments));
                break;
            case 'cat_cafe_dot_ask':
                await runtime.connection.authorizeExternal(credential, 'business');
                result = await runtime.ask(dotAskArguments.parse(input.arguments));
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
