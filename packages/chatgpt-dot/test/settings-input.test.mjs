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

function bindingView(base, state, revision = state === "unbound" ? 0 : 1) {
	return { ...base, binding: { ...base.binding, state, revision } };
}

test("status is a pure rows projection and does not manufacture authorization, pairing, or tests", async (t) => {
	const { f, settings } = await runningFixture(t);
	const before = structuredClone(Object.fromEntries(f.records));
	const first = await settings.actions["dot.status"]({}, undefined, f.owner);
	const second = await settings.actions["dot.status"]({}, undefined, f.owner);
	assert.equal(first.render, "rows");
	assert.equal(first.data.rows[0].key, "pairing-not-started");
	assert.deepEqual(second, first);
	assert.deepEqual(Object.fromEntries(f.records), before);
});

test("Host prepare, Host bind, and Dot pairing are three separate owner actions", async (t) => {
	const presentation = {
		key: "proposal-a",
		label: "Connect existing cloud link",
		detail: "Tools (4); events (1)",
		actions: [
			{
				action: "bind-shared",
				label: "Connect",
				confirm: "Connect this exact surface?",
				input: { proposalRef: "proposal-a" },
			},
		],
	};
	let binding;
	let boundRef;
	let expiresAt;
	const { f, settings } = await runningFixture(t, async (f) => {
		const original = f.host.external.shared;
		expiresAt = Date.now() + 60_000;
		binding = bindingView(await original.status(), "unbound");
		f.host.external.shared = {
			status: async () => binding,
			prepare: async () => ({
				proposalRef: "proposal-a",
				expiresAt,
				presentation,
				connection: binding,
			}),
			bind: async (proposalRef) => {
				boundRef = proposalRef;
				binding = bindingView(binding, "active");
				return binding;
			},
			unbind: async () => assert.fail("unexpected unbind"),
		};
	});

	const prepared = await settings.actions["dot.prepare-shared"](
		{},
		undefined,
		f.owner,
	);
	assert.deepEqual(prepared, {
		render: "rows",
		data: { rows: [presentation], validUntil: expiresAt },
	});
	assert.equal(f.records.has("dot/connection/v1"), false);

	const connected = await settings.actions["dot.bind-shared"](
		{ input: { proposalRef: "proposal-a" } },
		undefined,
		f.owner,
	);
	assert.equal(boundRef, "proposal-a");
	assert.equal(connected.data.rows[0].key, "pairing-not-started");
	assert.equal(f.records.has("dot/connection/v1"), false);

	const begun = await settings.actions["dot.begin-pairing"](
		{},
		undefined,
		f.owner,
	);
	assert.equal(begun.data.rows[0].key, "waiting-subscription");
	assert.ok(f.records.get("dot/connection/v1").value.pairingCode);
	const instructions = await settings.actions["dot.show-instructions"](
		{},
		undefined,
		f.owner,
	);
	assert.equal(instructions.render, "text");
	assert.match(instructions.data, /pairing_code=/);
	assert.match(instructions.data, /personal plugin.*Refresh/);
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

test("missing deployment produces one honest stage without pairing", async (t) => {
	let prepared = 0;
	const { f, settings } = await runningFixture(t, async (f) => {
		const active = await f.host.external.shared.status();
		const blocked = {
			deployment: { ...active.deployment, state: "missing-endpoint" },
			binding: bindingView(active, "unbound").binding,
		};
		f.host.external.shared = {
			status: async () => blocked,
			prepare: async () => {
				prepared += 1;
				return {
					proposalRef: "",
					expiresAt: 0,
					presentation: {
						key: "blocked",
						label: "Blocked",
						detail: "No endpoint",
						actions: [],
					},
					connection: blocked,
				};
			},
			bind: async () => assert.fail("unexpected bind"),
			unbind: async () => assert.fail("unexpected unbind"),
		};
	});

	const result = await settings.actions["dot.status"]({}, undefined, f.owner);
	assert.equal(result.data.rows[0].key, "deployment-blocked");
	assert.deepEqual(result.data.rows[0].actions ?? [], []);
	assert.equal(prepared, 0);
	assert.equal(f.records.has("dot/connection/v1"), false);
});

test("authority drift after pairing creation revokes that attempt before returning failure", async (t) => {
	let calls = 0;
	const { f, settings } = await runningFixture(t, async (f) => {
		const active = await f.host.external.shared.status();
		f.host.external.shared.status = async () =>
			calls++ < 2 ? active : bindingView(active, "revoked", 2);
	});

	await assert.rejects(
		() => settings.actions["dot.begin-pairing"]({}, undefined, f.owner),
		/shared_binding_revoked/,
	);
	assert.ok(f.records.get("dot/connection/v1").value.revokedAt !== null);
});

test("owner disconnect revokes the approved shared slot before revoking the Dot pairing", async (t) => {
	const calls = [];
	const { f, settings } = await runningFixture(t, async (f) => {
		const active = await f.host.external.shared.status();
		f.host.external.shared = {
			status: async () => bindingView(active, "active", 7),
			prepare: async () => assert.fail("unexpected prepare"),
			bind: async () => assert.fail("unexpected bind"),
			unbind: async (revision) => {
				calls.push({ kind: "unbind", revision });
				return bindingView(active, "revoked", 8);
			},
		};
	});
	await settings.actions["dot.begin-pairing"]({}, undefined, f.owner);
	const original = f.host.storage.compareAndSet.bind(f.host.storage);
	f.host.storage.compareAndSet = async (...args) => {
		if (args[0] === "dot/connection/v1")
			calls.push({ kind: "pairing-revoked" });
		return original(...args);
	};

	await settings.actions["dot.disconnect"]({}, undefined, f.owner);
	assert.deepEqual(calls, [
		{ kind: "unbind", revision: 7 },
		{ kind: "pairing-revoked" },
	]);
});

test("a known roundtrip delivery failure is immediately diagnosable and retry preserves prior evidence", async (t) => {
	const f = fixture(t);
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
