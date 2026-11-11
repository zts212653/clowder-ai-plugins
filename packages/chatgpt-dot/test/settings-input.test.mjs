import assert from "node:assert/strict";
import { test } from "node:test";
import { createDotPlugin } from "../src/plugin-entrypoint.ts";
import { DotConnection } from "../src/connection.ts";
import { TemporaryEndpointController } from "../src/temporary-endpoint.ts";
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
	assert.equal(first.data.rows[0]?.label, "待连接");
	assert.deepEqual(second.data.rows, first.data.rows);
	assert.ok(first.data.pollUntil > Date.now());
	assert.ok(second.data.pollUntil <= Date.now() + 5 * 60_000);
	assert.deepEqual(Object.fromEntries(f.records), before);
});

test("legacy pairing remains usable while the journey asks for a real public endpoint", async (t) => {
	const { f, settings } = await runningFixture(t);
	const begun = await settings.actions["dot.begin-pairing"](
		{},
		undefined,
		f.owner,
	);
	assert.equal(begun.data.rows[0]?.label, "待连接");
	assert.ok(f.records.get("dot/connection/v1").value.pairingCode);
	const instructions = await settings.actions["dot.show-instructions"](
		{},
		undefined,
		f.owner,
	);
	assert.equal(instructions.render, "text");
	assert.match(instructions.data, /pairing_code=/);
});

test("one owner action supplies the Work connection message without a separate pairing step", async (t) => {
	const { f, settings } = await runningFixture(t, seedLegacyPublicEndpoint);
	await assert.rejects(
		() => settings.actions["dot.show-instructions"]({}, undefined, undefined),
		/owner/,
	);
	assert.equal(f.records.has("dot/connection/v1"), false);
	const first = await settings.actions["dot.show-instructions"](
		{},
		undefined,
		f.owner,
	);
	const state = structuredClone(f.records.get("dot/connection/v1").value);
	assert.equal(first.render, "text");
	assert.match(first.data, /events\/subscribe/);
	assert.match(first.data, new RegExp(`attempt_id=${state.attemptId}`));
	assert.match(first.data, new RegExp(`pairing_code=${state.pairingCode}`));
	await assert.rejects(
		() =>
			settings.actions["dot.show-instructions"]({}, undefined, {
				...f.owner,
				userId: "intruder",
			}),
		/owner/,
	);
	const repeated = await settings.actions["dot.show-instructions"](
		{},
		undefined,
		f.owner,
	);
	assert.deepEqual(repeated, first);
	assert.equal(
		f.records.get("dot/connection/v1").value.attemptId,
		state.attemptId,
	);
	assert.equal(
		f.records.get("dot/external/v1").value.endpoint.serverUrl,
		"https://dot.example/plugin/mcp?token=fixture",
	);
	const status = await settings.actions["dot.status"]({}, undefined, f.owner);
	assert.equal(status.data.rows[0].key, "waiting-subscription");
	assert.equal(
		status.data.rows.some((row) => row.key === "connection-message"),
		false,
	);
	assert.equal(
		JSON.stringify(status.data).includes(state.pairingCode),
		false,
		"status must not repeat the subscription message",
	);
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
	assert.equal(status.data.rows[0]?.label, "待连接");
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
	assert.equal(result.data.rows[0]?.label, "待连接");
	assert.equal(f.records.has("dot/connection/v1"), false);
});

test("entry actions consume the current configuration draft passed by the Host", async (t) => {
	const now = 1_800_000_000_000;
	const issuedTtls = [];
	let temporaryStarts = 0;
	const f = fixture(t, {
		config: {
			longLivedServerUrlTemplate:
				"https://saved.invalid/api/plugins/official.chatgpt-dot/mcp?token={token}",
			externalTokenDays: 180,
			temporaryEndpointHours: 1,
		},
		capability: {
			issueExternal: async ({ ttlSeconds }) => {
				issuedTtls.push(ttlSeconds);
				const id = issuedTtls.length;
				return {
					token: `draft-token-${id}`,
					tokenId: `draft-jti-${id}`,
					issuedAt: 1,
					expiresAt: 2_000_000_000,
					refreshRecommendedAt: 1_900_000_000,
					forwarding: {
						upstreamLoopbackOrigin: "http://127.0.0.1:5182",
						relativePath: "/api/plugin-runtime/handle",
						method: "POST",
					},
				};
			},
			inspectExternal: async () => ({
				usable: true,
				reason: "usable",
				refreshRecommended: false,
			}),
		},
	});
	let temporaryInput;
	const originalStart = TemporaryEndpointController.prototype.start;
	TemporaryEndpointController.prototype.start = async function (input) {
		temporaryStarts += 1;
		temporaryInput = structuredClone(input);
		return {
			generation: "draft-generation",
			serverUrl: `https://temporary.example/mcp?token=${input.token}`,
			startedAt: now,
			expiresAt: now + input.ttlMs,
		};
	};
	t.after(() => {
		TemporaryEndpointController.prototype.start = originalStart;
	});
	const module = createDotPlugin({
		sendWebhook: f.sendWebhook,
		now: () => now,
	});
	const settings = await module.settings(f.host);
	const active = await module.start(f.host);
	t.after(async () => {
		settings.dispose();
		await active.stop({ reason: "test" });
	});

	const longLived = await settings.actions["dot.use-long-lived"](
		{
			input: {
				longLivedServerUrlTemplate:
					"https://draft.example/api/plugins/official.chatgpt-dot/mcp?token={token}",
				externalTokenDays: "7",
			},
		},
		undefined,
		f.owner,
	);
	assert.equal(
		longLived.label,
		undefined,
		"required setup content must not rely on label rendering",
	);
	const longToken = f.records.get("dot/external/v1").value.pending.token;
	assert.equal(
		longLived.data,
		`https://draft.example/api/plugins/official.chatgpt-dot/mcp?token=${longToken}`,
	);
	assert.equal(
		f.records.has("dot/connection/v1"),
		false,
		"URL generation is separate from subscription message generation",
	);
	assert.equal(issuedTtls.length, 0, "credential lifetime is plugin-owned");
	assert.equal(f.records.get("dot/external/v1").value.pending.expiresAt, null);
	const afterGeneration = await settings.actions["dot.status"](
		{},
		undefined,
		f.owner,
	);
	assert.equal(
		afterGeneration.data.rows.some((row) => row.key === "connection-message"),
		false,
	);
	assert.equal(
		afterGeneration.data.rows[0].actions?.some(
			(action) => action.action === "show-instructions",
		) ?? false,
		false,
	);
	assert.equal(
		f.records.get("dot/external/v1").value.pending.discoveredAt,
		null,
	);
	const subscriptionMessage = await settings.actions["dot.show-instructions"](
		{},
		undefined,
		f.owner,
	);
	assert.match(subscriptionMessage.data, /dot\.summoned/);
	assert.doesNotMatch(subscriptionMessage.data, /draft-token-1|https:\/\//);
	const repeatedLongLived = await settings.actions["dot.use-long-lived"](
		{
			input: {
				longLivedServerUrlTemplate:
					"https://draft.example/api/plugins/official.chatgpt-dot/mcp?token={token}",
				externalTokenDays: "7",
			},
		},
		undefined,
		f.owner,
	);
	assert.equal(repeatedLongLived.data, longLived.data);
	assert.equal(
		issuedTtls.length,
		0,
		"repeating the setup action must not silently rotate the external credential",
	);

	const temporary = await settings.actions["dot.start-temporary"](
		{
			input: { temporaryEndpointHours: "2.5" },
		},
		undefined,
		f.owner,
	);
	assert.equal(temporary.label, undefined);
	assert.equal(
		temporary.data,
		`https://temporary.example/mcp?token=${temporaryInput.token}`,
	);
	assert.equal(temporaryInput.ttlMs, 2.5 * 60 * 60_000);
	assert.equal(
		f.records.get("dot/external/v1").value.pending.expiresAt,
		Math.floor(now / 1000) + 2.5 * 60 * 60,
	);
	assert.equal(temporaryInput.relativePath, "/mcp");
	const repeatedTemporary = await settings.actions["dot.start-temporary"](
		{
			input: { temporaryEndpointHours: "2.5" },
		},
		undefined,
		f.owner,
	);
	assert.equal(repeatedTemporary.data, temporary.data);
	assert.equal(
		issuedTtls.length,
		0,
		"an active temporary endpoint must keep its existing external credential",
	);
	assert.equal(temporaryStarts, 1);
});

test("owner can prepare a connection message before discovery without granting verification authority", async (t) => {
	const { f, settings } = await runningFixture(t);
	await f.host.storage.set("dot/external/v1", {
		v: 1,
		revision: 2,
		current: null,
		pending: {
			kind: "pending",
			candidateId: "candidate",
			revision: 1,
			token: "token",
			tokenId: "jti",
			issuedAt: 1,
			expiresAt: 2_000_000_000,
			refreshRecommendedAt: 1_900_000_000,
			createdAt: 1,
			discoveredAt: null,
			pairingAttemptId: null,
			verificationEventId: null,
			verificationReadAt: null,
			verificationReplyAt: null,
		},
		endpoint: {
			mode: "long-lived",
			serverUrl: "https://dot.example/mcp?token=token",
			reachableAt: null,
		},
	});
	const result = await settings.actions["dot.show-instructions"](
		{},
		undefined,
		f.owner,
	);
	assert.match(result.data, /events\/subscribe/);
	const external = f.records.get("dot/external/v1").value;
	assert.equal(external.pending.discoveredAt, null);
	assert.equal(external.current, null);
	assert.equal(
		external.pending.pairingAttemptId,
		f.records.get("dot/connection/v1").value.attemptId,
	);
	const connection = new DotConnection(
		f.host,
		f.sendWebhook,
		new AbortController().signal,
	);
	await assert.rejects(
		() => connection.bindPendingVerification("test-event"),
		/discovery_required/,
	);
});

test("an already promoted signed credential remains reusable at a real millisecond clock", async (t) => {
	const { f, settings } = await runningFixture(t);
	const now = Math.floor(Date.now() / 1000);
	const serverUrl =
		"https://dot.example/api/plugin-runtime/handle?token=current-token";
	await f.host.storage.set("dot/external/v1", {
		v: 1,
		revision: 1,
		pending: null,
		current: {
			kind: "signed",
			token: "current-token",
			tokenId: "current-jti",
			issuedAt: now,
			expiresAt: now + 3600,
			refreshRecommendedAt: now + 1800,
		},
		endpoint: { mode: "long-lived", serverUrl, reachableAt: now * 1000 },
	});
	const result = await settings.actions["dot.use-long-lived"](
		{},
		undefined,
		f.owner,
	);
	assert.ok(result.data.includes(serverUrl));
	assert.equal(f.records.get("dot/external/v1").value.pending, null);
});

test("owner disconnect revokes Dot credentials before revoking the pairing", async (t) => {
	const calls = [];
	const { f, settings } = await runningFixture(t);
	await settings.actions["dot.begin-pairing"]({}, undefined, f.owner);
	const original = f.host.storage.compareAndSet.bind(f.host.storage);
	f.host.storage.compareAndSet = async (...args) => {
		if (args[0] === "dot/external/v1")
			calls.push({ kind: "credential-revoked" });
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
