import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BUNDLED_TUNNEL_SHA256, TemporaryEndpointController } from "../src/temporary-endpoint.ts";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const runnerPath = resolve(fileURLToPath(new URL("../src/temporary-endpoint-runner.mjs", import.meta.url)));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const live = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("published darwin-arm64 tunnel binary matches its reviewed manifest identity", async () => {
	const binary = fileURLToPath(new URL("../assets/bin/darwin-arm64/cloudflared", import.meta.url));
	const manifest = JSON.parse(await readFile(fileURLToPath(new URL("../assets/runtime-assets.json", import.meta.url)), "utf8"));
	const bytes = await readFile(binary);
	assert.equal(createHash("sha256").update(bytes).digest("hex"), BUNDLED_TUNNEL_SHA256);
	assert.equal(manifest.assets[0].sha256, BUNDLED_TUNNEL_SHA256);
	assert.notEqual((await stat(binary)).mode & 0o111, 0);
});

async function fakeTunnel(t, root) {
	const path = join(root, "fake-cloudflared.mjs");
	await writeFile(path, `#!/usr/bin/env node\nconsole.error('https://fixture.trycloudflare.com');\nsetInterval(() => {}, 1000);\n`);
	await chmod(path, 0o755);
	return path;
}

async function fakeTunnelWithPid(root) {
	const pidFile = join(root, "fake-cloudflared.pid");
	const path = join(root, "fake-cloudflared-with-pid.mjs");
	await writeFile(path, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nconsole.error('https://fixture.trycloudflare.com');\nsetInterval(() => {}, 1000);\n`);
	await chmod(path, 0o755);
	return { path, pidFile };
}

async function listening(server) {
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("listener missing");
	return `http://127.0.0.1:${address.port}`;
}

test("forward-only runner rejects Host sibling paths, encoded variants and upgrades before upstream", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "dot-runner-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	let upstreamCalls = 0;
	const upstream = http.createServer((request, response) => {
		upstreamCalls++;
		assert.equal(request.url, "/api/plugin-runtime/handle");
		assert.equal(request.headers.authorization, "Bearer signed-token");
		assert.equal(request.headers.cookie, undefined);
		response.writeHead(200, { "content-type": "application/json" });
		response.end('{"ok":true}');
	});
	const upstreamOrigin = await listening(upstream);
	t.after(() => new Promise((resolve) => upstream.close(resolve)));
	const child = fork(runnerPath, [await fakeTunnel(t, root)], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
	t.after(() => child.exitCode === null && child.kill("SIGKILL"));
	const ready = new Promise((resolve, reject) => {
		child.on("message", (message) => message?.type === "ready" && resolve(message));
		child.once("exit", () => reject(new Error("runner exited")));
	});
	child.send({
		type: "start",
		upstreamLoopbackOrigin: upstreamOrigin,
		relativePath: "/api/plugin-runtime/handle",
		method: "POST",
		token: "signed-token",
		expiresAt: Date.now() + 60_000,
	});
	const { listenerOrigin } = await ready;
	for (const target of ["/api/session", "/api/cats", "/mcp%2F..%2Fapi%2Fsession", "//mcp?token=signed-token"])
		assert.equal((await fetch(listenerOrigin + target, { method: "POST", body: "{}" })).status, 404);
	assert.equal(upstreamCalls, 0);
	const accepted = await fetch(`${listenerOrigin}/mcp?token=signed-token`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie: "owner=secret", host: "evil.invalid" },
		body: "{}",
	});
	assert.equal(accepted.status, 200);
	assert.equal(upstreamCalls, 1);
	child.send({ type: "stop", reason: "owner_stop" });
	await new Promise((resolve) => child.once("exit", resolve));
	await assert.rejects(fetch(`${listenerOrigin}/mcp?token=signed-token`, { method: "POST", body: "{}" }));
});

test("forward-only runner preserves standard MCP protocol headers", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "dot-runner-mcp-headers-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const observed = [];
	const upstream = http.createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		observed.push({ method: body.method, headers: request.headers });
		if (body.method === "notifications/initialized") {
			response.writeHead(202).end();
			return;
		}
		const result = body.method === "initialize"
			? {
				protocolVersion: "2025-11-25",
				capabilities: { tools: {} },
				serverInfo: { name: "runner-fixture", version: "1.0.0" },
			}
			: { tools: [] };
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
	});
	const upstreamOrigin = await listening(upstream);
	t.after(() => new Promise((resolve) => upstream.close(resolve)));
	const child = fork(runnerPath, [await fakeTunnel(t, root)], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
	t.after(() => child.exitCode === null && child.kill("SIGKILL"));
	const ready = new Promise((resolve, reject) => {
		child.on("message", (message) => message?.type === "ready" && resolve(message));
		child.once("exit", () => reject(new Error("runner exited")));
	});
	child.send({
		type: "start",
		upstreamLoopbackOrigin: upstreamOrigin,
		relativePath: "/api/plugin-runtime/handle",
		method: "POST",
		token: "signed-token",
		expiresAt: Date.now() + 60_000,
	});
	const { listenerOrigin } = await ready;
	const transport = new StreamableHTTPClientTransport(
		new URL(`${listenerOrigin}/mcp?token=signed-token`),
	);
	const client = new Client(
		{ name: "runner-conformance-test", version: "1.0.0" },
		{ capabilities: {} },
	);
	t.after(() => client.close());
	await client.connect(transport);
	await client.listTools();
	const listed = observed.find((entry) => entry.method === "tools/list");
	assert.ok(listed);
	assert.equal(listed.headers["mcp-protocol-version"], "2025-11-25");
	assert.equal(listed.headers.authorization, "Bearer signed-token");
	child.send({ type: "stop", reason: "owner_stop" });
	await new Promise((resolve) => child.once("exit", resolve));
});

test("controller publishes owner URL without clipboard and closes its exact runner", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "dot-controller-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const controller = new TemporaryEndpointController({
		runnerPath,
		binaryPath: await fakeTunnel(t, root),
		fetch: async () => new Response("{}", { status: 401 }),
		startupTimeoutMs: 2_000,
	});
	t.after(() => controller.stop("owner_stop"));
	const lease = await controller.start({
		upstreamLoopbackOrigin: "http://127.0.0.1:5182",
		relativePath: "/api/plugin-runtime/handle",
		method: "POST",
		token: "first-token",
		ttlMs: 60_000,
	});
	assert.equal(lease.serverUrl, "https://fixture.trycloudflare.com/mcp?token=first-token");
	assert.equal(
		controller.allowToken("second-token").serverUrl,
		"https://fixture.trycloudflare.com/mcp?token=second-token",
	);
	await controller.stop("owner_stop");
	assert.throws(() => controller.allowToken("late-token"), /unavailable/);
});

test("controller waits through transient edge responses without extending the startup deadline", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "dot-controller-probe-retry-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const statuses = [502, 404, 401];
	let probes = 0;
	const controller = new TemporaryEndpointController({
		runnerPath,
		binaryPath: await fakeTunnel(t, root),
		fetch: async () => new Response("{}", { status: statuses[probes++] ?? 401 }),
		// Allow process startup plus two 250ms probe retries on loaded CI hosts.
		startupTimeoutMs: 5_000,
	});
	t.after(() => controller.stop("owner_stop"));
	const lease = await controller.start({
		upstreamLoopbackOrigin: "http://127.0.0.1:5182",
		relativePath: "/api/plugin-runtime/handle",
		method: "POST",
		token: "eventually-ready-token",
		ttlMs: 60_000,
	});
	assert.equal(probes, 3);
	assert.equal(lease.serverUrl, "https://fixture.trycloudflare.com/mcp?token=eventually-ready-token");
});

test("stop during binary preparation cancels publication before a runner can become active", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "dot-controller-start-stop-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const controller = new TemporaryEndpointController({
		runnerPath,
		binaryPath: await fakeTunnel(t, root),
		fetch: async () => new Response("{}", { status: 401 }),
		startupTimeoutMs: 2_000,
	});
	const starting = controller.start({
		upstreamLoopbackOrigin: "http://127.0.0.1:5182",
		relativePath: "/api/plugin-runtime/handle",
		method: "POST",
		token: "cancelled-token",
		ttlMs: 60_000,
	});
	await controller.stop("owner_stop");
	await assert.rejects(starting, /cancel/);
	assert.throws(() => controller.allowToken("late-token"), /unavailable/);
});

test("an unfinished upload cannot keep the tunnel alive after runner stop", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "dot-runner-open-upload-"));
	const tunnel = await fakeTunnelWithPid(root);
	const child = fork(runnerPath, [tunnel.path], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
	let request;
	let pid;
	t.after(async () => {
		request?.destroy();
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		if (pid && live(pid)) process.kill(pid, "SIGKILL");
		await rm(root, { recursive: true, force: true });
	});
	const ready = new Promise((resolve, reject) => {
		child.on("message", (message) => message?.type === "ready" && resolve(message));
		child.once("exit", () => reject(new Error("runner exited")));
	});
	child.send({
		type: "start", upstreamLoopbackOrigin: "http://127.0.0.1:1",
		relativePath: "/api/plugin-runtime/handle", method: "POST", token: "fixture-token",
		expiresAt: Date.now() + 60_000,
	});
	const info = await ready;
	pid = Number(await readFile(tunnel.pidFile, "utf8"));
	request = http.request(`${info.listenerOrigin}/mcp?token=fixture-token`, {
		method: "POST", headers: { "content-type": "application/json", "content-length": "100" },
	});
	request.on("error", () => {});
	request.write("{");
	await pause(100);
	child.send({ type: "stop", reason: "owner_stop" });
	await new Promise((resolve) => child.once("exit", resolve));
	assert.equal(live(pid), false);
});

test("an interrupted authorized upload cannot crash the runner or strand its tunnel", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "dot-runner-interrupted-upload-"));
	const tunnel = await fakeTunnelWithPid(root);
	const child = fork(runnerPath, [tunnel.path], { stdio: ["ignore", "ignore", "ignore", "ipc"], detached: true });
	let request;
	let pid;
	t.after(async () => {
		request?.destroy();
		try { process.kill(-child.pid, "SIGKILL"); } catch {}
		if (pid && live(pid)) process.kill(pid, "SIGKILL");
		await rm(root, { recursive: true, force: true });
	});
	const ready = new Promise((resolve, reject) => {
		child.on("message", (message) => message?.type === "ready" && resolve(message));
		child.once("exit", () => reject(new Error("runner exited")));
	});
	child.send({
		type: "start", upstreamLoopbackOrigin: "http://127.0.0.1:1",
		relativePath: "/api/plugin-runtime/handle", method: "POST", token: "fixture-token",
		expiresAt: Date.now() + 60_000,
	});
	const info = await ready;
	pid = Number(await readFile(tunnel.pidFile, "utf8"));
	request = http.request(`${info.listenerOrigin}/mcp?token=fixture-token`, {
		method: "POST", headers: { "content-type": "application/json", "content-length": "100" },
	});
	request.on("error", () => {});
	request.write("{");
	await pause(100);
	request.destroy();
	await pause(300);
	assert.equal(child.exitCode, null, "request stream errors stay inside the request lifecycle");
	child.send({ type: "stop", reason: "owner_stop" });
	await new Promise((resolve) => child.once("exit", resolve));
	assert.equal(live(pid), false);
});

test("controller reaps the detached tunnel group after an unexpected runner exit", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "dot-controller-runner-exit-"));
	const tunnel = await fakeTunnelWithPid(root);
	const runnerPidFile = join(root, "runner.pid");
	const wrapper = join(root, "runner-wrapper.mjs");
	await writeFile(
		wrapper,
		`import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(runnerPidFile)}, String(process.pid));\nawait import(${JSON.stringify(runnerPath)});\n`,
	);
	const controller = new TemporaryEndpointController({
		runnerPath: wrapper,
		binaryPath: tunnel.path,
		fetch: async () => new Response("{}", { status: 401 }),
		startupTimeoutMs: 2_000,
	});
	let runnerPid;
	let tunnelPid;
	t.after(async () => {
		await controller.stop("owner_stop");
		if (runnerPid) try { process.kill(-runnerPid, "SIGKILL"); } catch {}
		if (tunnelPid && live(tunnelPid)) process.kill(tunnelPid, "SIGKILL");
		await rm(root, { recursive: true, force: true });
	});
	await controller.start({
		upstreamLoopbackOrigin: "http://127.0.0.1:1",
		relativePath: "/api/plugin-runtime/handle",
		method: "POST",
		token: "fixture-token",
		ttlMs: 60_000,
	});
	runnerPid = Number(await readFile(runnerPidFile, "utf8"));
	tunnelPid = Number(await readFile(tunnel.pidFile, "utf8"));
	process.kill(runnerPid, "SIGKILL");
	await pause(1_000);
	assert.equal(live(tunnelPid), false);
	assert.throws(() => controller.allowToken("late-token"), /unavailable/u);
});

test("controller materializes a verified non-executable packaged asset into private runtime storage", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "dot-controller-materialize-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const binaryPath = await fakeTunnel(t, root);
	await chmod(binaryPath, 0o644);
	const bytes = await readFile(binaryPath);
	const controller = new TemporaryEndpointController({
		runnerPath,
		binaryPath,
		expectedBinarySha256: createHash("sha256").update(bytes).digest("hex"),
		runtimeDirectory: join(root, "private-runtime"),
		fetch: async () => new Response("{}", { status: 401 }),
		startupTimeoutMs: 2_000,
	});
	t.after(() => controller.stop("owner_stop"));
	await controller.start({
		upstreamLoopbackOrigin: "http://127.0.0.1:5182",
		relativePath: "/api/plugin-runtime/handle",
		method: "POST",
		token: "materialized-token",
		ttlMs: 60_000,
	});
	const materialized = join(root, "private-runtime/cloudflared-darwin-arm64");
	assert.deepEqual(await readFile(materialized), bytes);
	assert.equal((await stat(materialized)).mode & 0o777, 0o700);
});

test("controller closes a provisional runner when the public probe fails", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "dot-controller-probe-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const tunnel = await fakeTunnelWithPid(root);
	const controller = new TemporaryEndpointController({
		runnerPath,
		binaryPath: tunnel.path,
		fetch: async () => new Response("{}", { status: 200 }),
		startupTimeoutMs: 2_000,
	});
	await assert.rejects(controller.start({
		upstreamLoopbackOrigin: "http://127.0.0.1:5182",
		relativePath: "/api/plugin-runtime/handle",
		method: "POST",
		token: "first-token",
		ttlMs: 60_000,
	}), /probe_failed/);
	await new Promise((resolve) => setTimeout(resolve, 100));
	const pid = Number(await import("node:fs/promises").then(({ readFile }) => readFile(tunnel.pidFile, "utf8")));
	assert.throws(() => process.kill(pid, 0));
});
