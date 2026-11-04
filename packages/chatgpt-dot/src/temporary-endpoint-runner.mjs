import { spawn } from "node:child_process";
import http from "node:http";

const binaryPath = process.argv[2];
let server;
let tunnel;
let stopping = false;
const acceptedTokens = new Set();

const reply = (response, status, body) => {
	response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	response.end(JSON.stringify(body));
};

async function stop(reason) {
	if (stopping) return;
	stopping = true;
	await new Promise((resolve) => server?.close(resolve) ?? resolve());
	if (tunnel && tunnel.exitCode === null && tunnel.signalCode === null) tunnel.kill("SIGTERM");
	const timeout = setTimeout(() => {
		if (tunnel && tunnel.exitCode === null && tunnel.signalCode === null) tunnel.kill("SIGKILL");
	}, 1500);
	if (tunnel && tunnel.exitCode === null && tunnel.signalCode === null)
		await new Promise((resolve) => tunnel.once("exit", resolve));
	clearTimeout(timeout);
	process.disconnect?.();
	process.exit(reason === "expired" || reason === "owner_stop" || reason === "replace" ? 0 : 1);
}

process.on("message", async (message) => {
	if (message?.type === "stop") return stop(message.reason);
	if (message?.type === "allow-token" && typeof message.token === "string") {
		acceptedTokens.add(message.token);
		return;
	}
	if (message?.type !== "start" || server || !binaryPath) return;
	const { upstreamLoopbackOrigin, relativePath, method, token, expiresAt } = message;
	try {
		const upstream = new URL(upstreamLoopbackOrigin);
		if (upstream.protocol !== "http:" || !["127.0.0.1", "::1", "localhost"].includes(upstream.hostname))
			throw new Error("dot_temporary_upstream_invalid");
		if (method !== "POST" || !/^\/[A-Za-z0-9/_-]+$/u.test(relativePath))
			throw new Error("dot_temporary_route_invalid");
		acceptedTokens.add(token);
		server = http.createServer(async (request, response) => {
			const matchedToken = [...acceptedTokens].find(
				(candidate) => request.url === `/mcp?token=${encodeURIComponent(candidate)}`,
			);
			if (
				request.method !== "POST" || !matchedToken || request.headers.upgrade ||
				request.headers.connection?.toLowerCase().includes("upgrade")
			) return reply(response, request.url === "/mcp" ? 401 : 404, { error: "request_rejected" });
			const chunks = [];
			let size = 0;
			for await (const chunk of request) {
				size += chunk.length;
				if (size > 15 * 1024 * 1024) return reply(response, 413, { error: "body_too_large" });
				chunks.push(chunk);
			}
			const headers = { authorization: `Bearer ${matchedToken}` };
			for (const name of ["accept", "content-type", "mcp-protocol-version", "mcp-session-id", "last-event-id"])
				if (typeof request.headers[name] === "string") headers[name] = request.headers[name];
			const target = new URL(relativePath, upstream);
			const result = await fetch(target, {
				method: "POST",
				headers,
				body: Buffer.concat(chunks),
				redirect: "manual",
				signal: AbortSignal.timeout(30_000),
			});
			const responseHeaders = {};
			for (const name of ["content-type", "cache-control", "retry-after", "x-content-type-options"])
				if (result.headers.has(name)) responseHeaders[name] = result.headers.get(name);
			response.writeHead(result.status, responseHeaders);
			response.end(Buffer.from(await result.arrayBuffer()));
		});
		server.on("upgrade", (_request, socket) => socket.destroy());
		server.on("connect", (_request, socket) => socket.destroy());
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("dot_temporary_listener_failed");
		tunnel = spawn(binaryPath, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${address.port}`], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		const listenerOrigin = `http://127.0.0.1:${address.port}`;
		const observe = (chunk) => {
			output = `${output}${chunk}`.slice(-32_768);
			const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/iu);
			if (match) process.send?.({ type: "ready", publicBaseUrl: match[0], listenerOrigin });
		};
		tunnel.stdout.on("data", observe);
		tunnel.stderr.on("data", observe);
		tunnel.once("exit", () => void stop("tunnel_exit"));
		const remaining = expiresAt - Date.now();
		setTimeout(() => void stop("expired"), Math.max(1, remaining)).unref?.();
	} catch (error) {
		process.send?.({ type: "error", reason: error instanceof Error ? error.message : "dot_temporary_failed" });
		void stop("startup_failed");
	}
});

process.on("disconnect", () => void stop("owner_stop"));
process.on("SIGTERM", () => void stop("owner_stop"));
