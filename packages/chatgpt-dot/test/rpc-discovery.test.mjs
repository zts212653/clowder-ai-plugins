import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createDotPlugin } from "../src/plugin-entrypoint.ts";
import { fixture, mcp } from "./fixture.mjs";

test("subscription failure diagnostics distinguish arrival and RPC rejection without credentials", async (t) => {
	const f = fixture(t);
	const logs = [];
	f.host.log = (level, message, fields) => logs.push({ level, message, fields });
	const module = createDotPlugin({ sendWebhook: async () => { throw new Error("callback_connect_timeout"); } });
	const settings = await module.settings(f.host);
	const active = await module.start(f.host);
	t.after(async () => { settings.dispose(); await active.stop({ reason: "test" }); });
	await settings.actions["dot.show-instructions"]({}, undefined, f.owner);
	const state = f.records.get("dot/connection/v1").value;
	const response = await mcp(active, request("events/subscribe", {
		name: "dot.summoned", arguments: { attempt_id: state.attemptId, pairing_code: state.pairingCode },
		delivery: { mode: "webhook", url: "https://callbacks.example/private-path", secret: "whsec_" + Buffer.alloc(32, 3).toString("base64") },
	}));
	assert.equal(response.body.error.code, -32015);
	assert.deepEqual(logs, [
		{ level: "info", message: "dot_event_rpc_received", fields: { method: "events/subscribe" } },
		{ level: "warn", message: "dot_event_rpc_failed", fields: { method: "events/subscribe", code: -32015, reason: "callback_connect_timeout" } },
	]);
	assert.doesNotMatch(JSON.stringify(logs), /private-path|whsec_|pairing_code/);
	assert.equal(JSON.stringify(logs).includes(state.pairingCode), false);
});

function request(method, params, id = 1) {
	return {
		request: {
			method: "POST",
			headers: {},
			body: {
				jsonrpc: "2.0",
				id,
				method,
				...(params === undefined ? {} : { params }),
			},
		},
	};
}

async function serveActive(t, active, observed) {
	const server = createServer(async (request, response) => {
		if (request.method !== "POST") {
			response.writeHead(405).end();
			return;
		}
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		observed.push({ phase: "request", method: request.method });
		const handled = await active.handle({
			method: request.method,
			headers: Object.fromEntries(
				Object.entries(request.headers).filter((entry) => entry[1] !== undefined),
			),
			body: chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined,
		});
		observed.push({ phase: "response", status: handled.status });
		response.writeHead(handled.status, handled.headers);
		response.end(handled.body === null ? undefined : JSON.stringify(handled.body));
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	t.after(() => new Promise((resolve) => {
		server.closeAllConnections();
		server.close(resolve);
	}));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	return new URL(`http://127.0.0.1:${address.port}/mcp`);
}

test("connects through the standard Streamable HTTP MCP client", async (t) => {
	const f = fixture(t);
	f.host.dataPath = await mkdtemp(join(tmpdir(), "dot-standard-mcp-test-"));
	t.after(() => rm(f.host.dataPath, { recursive: true, force: true }));
	const active = await createDotPlugin({ sendWebhook: f.sendWebhook }).start(f.host);
	t.after(() => active.stop({ reason: "test" }));

	const observed = [];
	const endpoint = await serveActive(t, active, observed);
	const transport = new StreamableHTTPClientTransport(endpoint);
	const client = new Client(
		{ name: "dot-conformance-test", version: "1.0.0" },
		{ capabilities: {} },
	);
	t.after(() => client.close());
	let timeout;
	try {
		await Promise.race([
			client.connect(transport),
			new Promise((_, reject) => {
				timeout = setTimeout(
					() => reject(new Error(`standard MCP connect timed out: ${JSON.stringify(observed)}`)),
					5_000,
				);
			}),
		]);
	} finally {
		clearTimeout(timeout);
	}
	assert.equal(client.getServerVersion()?.name, "Clowder AI dot");
	assert.deepEqual(
		(await client.listTools()).tools.map((tool) => tool.name),
		[
			"cat_cafe_dot_read_source",
			"cat_cafe_dot_reply",
			"cat_cafe_dot_publish_image",
			"cat_cafe_dot_ask",
		],
	);
});

test("fresh install exposes protocol discovery before Dot pairing while business methods stay fenced", async (t) => {
	const f = fixture(t);
	f.host.dataPath = await mkdtemp(join(tmpdir(), "dot-discovery-test-"));
	t.after(() => rm(f.host.dataPath, { recursive: true, force: true }));

	const module = createDotPlugin({ sendWebhook: f.sendWebhook });
	const active = await module.start(f.host);
	t.after(() => active.stop({ reason: "test" }));

	assert.equal(f.records.has("dot/connection/v1"), false);

	const initialize = await mcp(active, request("initialize", {
		protocolVersion: "2025-11-25",
		capabilities: {},
		clientInfo: { name: "dot-direct-test", version: "1.0.0" },
	}));
	assert.equal(initialize.status, 200);
	assert.equal(initialize.body.result.protocolVersion, "2025-11-25");
	assert.equal("resultType" in initialize.body.result, false);
	assert.deepEqual(initialize.body.result.capabilities, { tools: {}, events: {} });

	const discover = await mcp(active, request("server/discover"));
	assert.equal(discover.status, 200);
	assert.equal(discover.body.result.resultType, "complete");
	assert.deepEqual(discover.body.result.supportedVersions, ["2026-07-28"]);
	assert.deepEqual(discover.body.result.capabilities, { tools: {}, events: {} });

	assert.equal((await mcp(active, request("ping"))).status, 200);

	const tools = await mcp(active, request("tools/list"));
	assert.equal(tools.status, 200);
	assert.deepEqual(
		tools.body.result.tools.map((tool) => tool.name),
		[
			"cat_cafe_dot_read_source",
			"cat_cafe_dot_reply",
			"cat_cafe_dot_publish_image",
			"cat_cafe_dot_ask",
		],
	);
	const modernTools = await mcp(active, request("tools/list", {
		_meta: {
			"io.modelcontextprotocol/protocolVersion": "2026-07-28",
			"io.modelcontextprotocol/clientInfo": { name: "dot-modern-test", version: "1.0.0" },
			"io.modelcontextprotocol/clientCapabilities": {},
		},
	}));
	assert.equal(modernTools.body.result.resultType, "complete");
	assert.deepEqual(
		modernTools.body.result._meta["io.modelcontextprotocol/serverInfo"],
		{ name: "Clowder AI dot", version: "0.2.0" },
	);

	const events = await mcp(active, request("events/list"));
	assert.equal(events.status, 200);
	assert.deepEqual(
		events.body.result.events.map((event) => event.name),
		["dot.summoned"],
	);

	const initialized = await mcp(
		active,
		{
			request: {
				method: "POST",
				headers: {},
				body: { jsonrpc: "2.0", method: "notifications/initialized" },
			},
		},
	);
	assert.equal(initialized.status, 202);

	for (const method of [
		"tools/call",
		"events/subscribe",
		"events/unsubscribe",
	]) {
		const response = await mcp(active, request(method, {}));
		assert.equal(response.status, 409, method);
		assert.deepEqual(response.body, { error: "dot_connection_unavailable" });
	}

	assert.equal(f.records.has("dot/connection/v1"), false);
});
