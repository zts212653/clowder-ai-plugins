import { createServer, type Server } from "node:http";
import type { VerifiedExternalCredential } from "./external-state.js";
import { httpRequestSchema, rpc } from "./rpc.js";
import type { DotRuntime } from "./runtime.js";

export const DOT_MCP_PATH = "/api/plugins/official.chatgpt-dot/mcp";

/** Both transports authenticate here; no client-supplied credential/principal is forwarded. */
export async function pluginMcpRequest(runtime: DotRuntime, raw: unknown) {
	const { request } = httpRequestSchema.parse({ request: raw });
	if (request.method !== "POST" || request.path !== "mcp")
		return {
			status: 405,
			headers: { "content-type": "application/json" },
			body: { error: "request_rejected" },
		};
	let credential: VerifiedExternalCredential;
	try {
		credential = await runtime.connection.authenticatePluginToken(
			requestToken(request.query?.token, request.headers),
		);
	} catch {
		return unauthorized();
	}
	return rpc(runtime, {
		method: "POST",
		headers: request.headers,
		body: request.body,
		credential,
	});
}

function unauthorized() {
	return {
		status: 401,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
		},
		body: { error: "dot_mcp_unauthorized" },
	};
}

function requestToken(
	query: unknown,
	headers: Readonly<Record<string, string | readonly string[] | undefined>>,
) {
	const bearer =
		typeof headers.authorization === "string" &&
		headers.authorization.startsWith("Bearer ")
			? headers.authorization.slice(7)
			: undefined;
	const local = headers["x-dot-access-token"];
	if (local !== undefined && typeof local !== "string")
		throw new Error("dot_mcp_unauthorized");
	if (local !== undefined && bearer !== undefined && local !== bearer)
		throw new Error("dot_mcp_unauthorized");
	const header = local ?? bearer;
	if (query !== undefined && header !== undefined && query !== header)
		throw new Error("dot_mcp_unauthorized");
	return query ?? header;
}

/** Activation-owned loopback target for quick tunnels and the optional official client. */
export async function startMcpLoopback(
	runtime: DotRuntime,
): Promise<{ origin: string; close(): Promise<void> }> {
	const pending = new Set<Promise<void>>();
	const server: Server = createServer((request, response) => {
		const task = (async () => {
			try {
				if (pending.size >= 16) {
					response.writeHead(429);
					response.end();
					return;
				}
				const url = new URL(request.url ?? "/", "http://127.0.0.1");
				if (url.pathname !== "/mcp" || request.method !== "POST") {
					response.writeHead(404);
					response.end();
					return;
				}
				if (url.searchParams.getAll("token").length > 1) {
					response.writeHead(401);
					response.end();
					return;
				}
				const query = Object.fromEntries(url.searchParams);
				try {
					await runtime.connection.authenticatePluginToken(
						requestToken(query.token, request.headers),
					);
				} catch {
					const result = unauthorized();
					response.writeHead(result.status, result.headers);
					response.end(JSON.stringify(result.body));
					return;
				}
				const chunks: Buffer[] = [];
				let size = 0;
				for await (const chunk of request) {
					size += chunk.length;
					if (size > 15 * 1024 * 1024) {
						response.writeHead(413);
						response.end();
						return;
					}
					chunks.push(chunk);
				}
				const result = await pluginMcpRequest(runtime, {
					method: "POST",
					path: "mcp",
					query,
					headers: request.headers,
					body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
				});
				response.writeHead(result.status, result.headers);
				response.end(
					result.body === null ? undefined : JSON.stringify(result.body),
				);
			} catch {
				if (!response.headersSent)
					response.writeHead(400, { "content-type": "application/json" });
				response.end('{"error":"request_rejected"}');
			}
		})();
		pending.add(task);
		void task.finally(() => pending.delete(task));
	});
	server.requestTimeout = 30_000;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("dot_mcp_listener_unavailable");
	return {
		origin: `http://127.0.0.1:${address.port}`,
		async close() {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
			await Promise.allSettled(pending);
		},
	};
}
