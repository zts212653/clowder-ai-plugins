import assert from "node:assert/strict";
import { test } from "node:test";
import { createDotPlugin } from "../src/plugin-entrypoint.ts";
import { fixture, mcp } from "./fixture.mjs";

async function runningFixture(t, setup = () => {}) {
	const f = fixture(t);
	await setup(f);
	const module = createDotPlugin({ sendWebhook: f.sendWebhook });
	const settings = await module.settings(f.host);
	const active = await module.start(f.host);
	t.after(async () => {
		settings.dispose();
		await active.stop({ reason: "test" });
	});
	return { f, settings };
}

async function seedLegacyPublicEndpoint(f) {
	await f.host.storage.set("dot/external/v1", {
		v: 1,
		revision: 1,
		current: { kind: "legacy", recordRef: "host.external" },
		pending: null,
		endpoint: {
			mode: "long-lived",
			serverUrl: "https://dot.example/plugin/mcp?token=fixture",
			reachableAt: null,
		},
	});
}

test("status is a pure rows projection and does not manufacture authorization, pairing, or tests", async (t) => {
	const { f, settings } = await runningFixture(t);
	const before = structuredClone(Object.fromEntries(f.records));
	const first = await settings.actions["dot.status"]({}, undefined, f.owner);
	const second = await settings.actions["dot.status"]({}, undefined, f.owner);
	assert.equal(first.render, "rows");
	assert.deepEqual(first.data.rows, []);
	assert.deepEqual(second, first);
	assert.deepEqual(Object.fromEntries(f.records), before);
});

test("legacy pairing remains usable while the journey asks for a real public endpoint", async (t) => {
	const { f, settings } = await runningFixture(t);
	const begun = await settings.actions["dot.begin-pairing"]({}, undefined, f.owner);
	assert.deepEqual(begun.data.rows, []);
	assert.ok(f.records.get("dot/connection/v1").value.pairingCode);
	const instructions = await settings.actions["dot.show-instructions"]({}, undefined, f.owner);
	assert.equal(instructions.render, "text");
	assert.match(instructions.data, /pairing_code=/);
});

test("a legacy credential starts when the Host exposes only a relative forwarding coordinate", async (t) => {
	const { f, settings } = await runningFixture(t, async (f) => {
		f.host.external.endpoint = "/plugin/mcp";
	});
	const external = f.records.get("dot/external/v1").value;
	assert.deepEqual(external.current, {
		kind: "legacy",
		recordRef: "host.external",
	});
	assert.deepEqual(external.endpoint, { mode: "absent" });

	const status = await settings.actions["dot.status"]({}, undefined, f.owner);
	assert.deepEqual(status.data.rows, []);
});

test("begin is idempotent and only the declared reconnect action rotates an existing attempt", async (t) => {
	const { f, settings } = await runningFixture(t);
	const params = {
		input: { reconnect: true },
		operationState: { currentAction: "status", updatedAt: 1 },
	};
	await settings.actions["dot.begin-pairing"](params, undefined, f.owner);
	const first = structuredClone(f.records.get("dot/connection/v1").value);
	await settings.actions["dot.begin-pairing"](params, undefined, f.owner);
	assert.equal(
		f.records.get("dot/connection/v1").value.attemptId,
		first.attemptId,
	);
	await settings.actions["dot.reconnect"]({}, undefined, f.owner);
	assert.notEqual(
		f.records.get("dot/connection/v1").value.attemptId,
		first.attemptId,
	);
});

test("missing endpoint leaves entry selection to native configuration variants", async (t) => {
	const { f, settings } = await runningFixture(t, async (f) => {
		f.host.external.endpoint = "";
		f.host.external.token = "";
	});
	const result = await settings.actions["dot.status"]({}, undefined, f.owner);
	assert.deepEqual(result.data.rows, []);
	assert.equal(f.records.has("dot/connection/v1"), false);
});

test("pending credential cannot start pairing before its own ChatGPT discovery", async (t) => {
	const { f, settings } = await runningFixture(t);
	await f.host.storage.set("dot/external/v1", {
		v: 1, revision: 2, current: null,
		pending: { kind: "pending", candidateId: "candidate", revision: 1, token: "token", tokenId: "jti", issuedAt: 1,
			expiresAt: 2_000_000_000, refreshRecommendedAt: 1_900_000_000, createdAt: 1, discoveredAt: null,
			pairingAttemptId: null, verificationEventId: null, verificationReadAt: null, verificationReplyAt: null },
		endpoint: { mode: "long-lived", serverUrl: "https://dot.example/mcp?token=token", reachableAt: null },
	});
	await assert.rejects(() => settings.actions["dot.begin-pairing"]({}, undefined, f.owner), /discovery_required/);
	assert.equal(f.records.has("dot/connection/v1"), false);
});

test("owner disconnect revokes Dot credentials before revoking the pairing", async (t) => {
	const calls = [];
	const { f, settings } = await runningFixture(t);
	await settings.actions["dot.begin-pairing"]({}, undefined, f.owner);
	const original = f.host.storage.compareAndSet.bind(f.host.storage);
	f.host.storage.compareAndSet = async (...args) => {
		if (args[0] === "dot/external/v1") calls.push({ kind: "credential-revoked" });
		if (args[0] === "dot/connection/v1")
			calls.push({ kind: "pairing-revoked" });
		return original(...args);
	};

	await settings.actions["dot.disconnect"]({}, undefined, f.owner);
	assert.deepEqual(calls, [
		{ kind: "credential-revoked" },
		{ kind: "pairing-revoked" },
	]);
});

test("a known roundtrip delivery failure is immediately diagnosable and retry preserves prior evidence", async (t) => {
	const f = fixture(t);
	await seedLegacyPublicEndpoint(f);
	let ordinaryDeliveries = 0;
	const module = createDotPlugin({
		sendWebhook: async (url, headers, body, signal) => {
			const data = JSON.parse(body);
			if (data.type === "verification")
				return f.sendWebhook(url, headers, body, signal);
			ordinaryDeliveries += 1;
			throw new Error("network unavailable");
		},
	});
	const settings = await module.settings(f.host);
	const active = await module.start(f.host);
	t.after(async () => {
		settings.dispose();
		await active.stop({ reason: "test" });
	});
	await settings.actions["dot.begin-pairing"]({}, undefined, f.owner);
	const credentials = structuredClone(f.records.get("dot/connection/v1").value);
	await mcp(active, {
		request: {
			method: "POST",
			headers: {},
			body: {
				jsonrpc: "2.0",
				id: 1,
				method: "events/subscribe",
				params: {
					name: "dot.summoned",
					arguments: {
						attempt_id: credentials.attemptId,
						pairing_code: credentials.pairingCode,
					},
					delivery: {
						mode: "webhook",
						url: "https://callbacks.example/dot",
						secret: `whsec_${Buffer.alloc(32, 3).toString("base64")}`,
					},
					ttlMs: null,
				},
			},
		},
	});

	const failed = await settings.actions["dot.roundtrip"](
		{},
		undefined,
		f.owner,
	);
	assert.equal(failed.data.rows[0].key, "verification-failed");
	const first = structuredClone(
		f.records.get("dot/connection/v1").value.testEventIds,
	);
	assert.equal(first.length, 1);
	assert.equal(
		f.records.get(`dot/dispatch/${first[0]}`).value.deliveryError,
		"dot_delivery_failed",
	);

	const retried = await settings.actions["dot.roundtrip"](
		{},
		undefined,
		f.owner,
	);
	assert.equal(retried.data.rows[0].key, "verification-failed");
	const retained = f.records.get("dot/connection/v1").value.testEventIds;
	assert.ok(ordinaryDeliveries >= 2);
	assert.equal(retained.length, 2);
	assert.equal(retained[0], first[0]);
	assert.ok(f.records.has(`dot/dispatch/${retained[0]}`));
	assert.ok(f.records.has(`dot/dispatch/${retained[1]}`));
});
