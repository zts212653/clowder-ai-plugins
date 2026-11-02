import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDotPlugin } from "../src/plugin-entrypoint.ts";
import { fixture, mcp } from "./fixture.mjs";

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

test("fresh install exposes protocol discovery before Dot pairing while business methods stay fenced", async (t) => {
	const f = fixture(t);
	f.host.dataPath = await mkdtemp(join(tmpdir(), "dot-discovery-test-"));
	t.after(() => rm(f.host.dataPath, { recursive: true, force: true }));

	const module = createDotPlugin({ sendWebhook: f.sendWebhook });
	const active = await module.start(f.host);
	t.after(() => active.stop({ reason: "test" }));

	assert.equal(f.records.has("dot/connection/v1"), false);

	const initialize = await mcp(active, request("initialize"));
	assert.equal(initialize.status, 200);
	assert.deepEqual(initialize.body.result.capabilities, { tools: {}, events: {} });

	const discover = await mcp(active, request("server/discover"));
	assert.equal(discover.status, 200);
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
