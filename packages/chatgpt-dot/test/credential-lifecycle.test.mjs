import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDotPlugin } from "../src/plugin-entrypoint.ts";
import { DotConnection } from "../src/connection.ts";
import { TemporaryEndpointController } from "../src/temporary-endpoint.ts";
import { CONNECTION_KEY, EXTERNAL_KEY } from "../src/store.ts";
import { fixture, mcp, paired } from "./fixture.mjs";
import { projectDotJourney } from "../src/journey-projection.ts";

const secret = "whsec_" + Buffer.alloc(32, 3).toString("base64");

function credential(id) {
	return {
		sub: "installed-dot-1",
		cap: "dot-mcp",
		jti: id,
		iat: 1,
		exp: 2_000_000_000,
	};
}

async function request(f, body, jti) {
	return mcp(f.active, {
		request: {
			method: "POST",
			headers: {},
			...(jti ? { credential: credential(jti) } : {}),
			body,
		},
	});
}

async function call(f, name, args, jti, id = 20) {
	return request(
		f,
		{
			jsonrpc: "2.0",
			id,
			method: "tools/call",
			params: { name, arguments: args },
		},
		jti,
	);
}

test("pending signed credential promotes only from its exact discovery, pairing and roundtrip evidence", async (t) => {
	let sequence = 0;
	const f = fixture(t, {
		config: {
			longLivedServerUrlTemplate:
				"https://dot.example/api/plugin-runtime/handle?token={token}",
			externalTokenDays: 30,
		},
		capability: {
			issueExternal: async () => {
				const n = ++sequence;
				return {
					token: `signed-token-${n}`,
					tokenId: `jti-${n}`,
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
	f.host.external.token = "";
	f.host.dataPath = await mkdtemp(join(tmpdir(), "dot-credential-test-"));
	t.after(() => rm(f.host.dataPath, { recursive: true, force: true }));
	f.module = createDotPlugin({ sendWebhook: f.sendWebhook });
	f.settings = await f.module.settings(f.host);
	f.active = await f.module.start(f.host);
	t.after(() => f.active.stop({ reason: "test" }));

	const signed = new DotConnection(
		f.host,
		f.sendWebhook,
		new AbortController().signal,
	);
	const { state: staged } = await signed.issuePending(f.owner, 30 * 86400);
	await signed.setLongLivedServerUrl(
		staged.pending.candidateId,
		"https://dot.example/api/plugin-runtime/handle?token=signed-token-1",
	);
	let external = f.records.get(EXTERNAL_KEY).value;
	assert.equal(external.current, null);
	assert.equal(external.pending.tokenId, "jti-1");

	await request(
		f,
		{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
		"jti-1",
	);
	const message = await f.settings.actions["dot.show-instructions"](
		{},
		undefined,
		f.owner,
	);
	assert.equal(message.render, "text");
	const connection = f.records.get(CONNECTION_KEY).value;
	await request(
		f,
		{
			jsonrpc: "2.0",
			id: 2,
			method: "events/subscribe",
			params: {
				name: "dot.summoned",
				arguments: {
					attempt_id: connection.attemptId,
					pairing_code: connection.pairingCode,
				},
				delivery: {
					mode: "webhook",
					url: "https://callbacks.example/dot",
					secret,
				},
				ttlMs: null,
			},
		},
		"jti-1",
	);
	await f.settings.actions["dot.roundtrip"]({}, undefined, f.owner);
	const afterTest = f.records.get(CONNECTION_KEY).value;
	const eventId = afterTest.testEventIds.at(-1);
	const dispatch = f.records.get(`dot/dispatch/${eventId}`).value;
	await call(f, "cat_cafe_dot_read_source", { event_id: eventId }, "jti-1");
	await call(
		f,
		"cat_cafe_dot_reply",
		{ event_id: eventId, content: `ok ${dispatch.expectedNonce}` },
		"jti-1",
	);

	external = f.records.get(EXTERNAL_KEY).value;
	assert.equal(external.current.tokenId, "jti-1");
	assert.equal(external.pending, null);
});

test("current credential activity cannot promote a pending replacement", async (t) => {
	const f = fixture(t);
	f.host.external.token = "";
	const external = {
		v: 1,
		revision: 1,
		current: {
			kind: "signed",
			token: "current-token",
			tokenId: "jti-current",
			issuedAt: 1,
			expiresAt: 2_000_000_000,
			refreshRecommendedAt: 1_900_000_000,
		},
		pending: {
			kind: "pending",
			candidateId: "candidate",
			revision: 1,
			token: "pending-token",
			tokenId: "jti-pending",
			issuedAt: 1,
			expiresAt: 2_000_000_000,
			refreshRecommendedAt: 1_900_000_000,
			createdAt: 1,
			discoveredAt: 2,
			pairingAttemptId: "attempt",
			verificationEventId: "dot_evt_" + "a".repeat(64),
			verificationReadAt: null,
			verificationReplyAt: null,
		},
		endpoint: {
			mode: "long-lived",
			serverUrl: "https://dot.example/mcp?token=pending-token",
			reachableAt: null,
		},
	};
	await f.host.storage.set(EXTERNAL_KEY, external);
	const connection = {
		v: 1,
		revision: 1,
		ownerUserId: "owner",
		pluginInstanceId: f.host.pluginInstanceId,
		agentKeyId: "key",
		attemptId: "attempt",
		pairingCode: "a".repeat(32),
		pairingExpiresAt: Date.now() + 60_000,
		pairedAt: Date.now(),
		pairedCallbackUrl: "https://callbacks.example/dot",
		subscription: {
			id: "sub",
			url: "https://callbacks.example/dot",
			secret,
			expiresAt: null,
			verifiedAt: Date.now(),
			previousSecret: null,
			rotationUntil: null,
		},
		lastSourceReadAt: null,
		lastReplyAt: null,
		lastImageAt: null,
		revokedAt: null,
		testEventIds: [],
	};
	await f.host.storage.set(CONNECTION_KEY, connection);
	const dot = new DotConnection(
		f.host,
		f.sendWebhook,
		new AbortController().signal,
	);
	await dot.recordPendingEvidence(
		credential("jti-current"),
		external.pending.verificationEventId,
		"read",
	);
	await dot.recordPendingEvidence(
		credential("jti-current"),
		external.pending.verificationEventId,
		"reply",
	);
	const retained = f.records.get(EXTERNAL_KEY).value;
	assert.equal(retained.current.tokenId, "jti-current");
	assert.equal(retained.pending.tokenId, "jti-pending");
	assert.equal(retained.pending.verificationReadAt, null);
	assert.equal(retained.pending.verificationReplyAt, null);
});

test("replacement inherits the exact healthy pairing and old dispatches cannot prove it ready", async (t) => {
	const f = await paired(t);
	const dot = new DotConnection(
		f.host,
		f.sendWebhook,
		new AbortController().signal,
	);
	f.host.capability = {
		issueExternal: async () => ({
			token: "pending",
			tokenId: "new-jti",
			issuedAt: 1,
			expiresAt: 2_000_000_000,
			refreshRecommendedAt: 1_900_000_000,
		}),
	};
	await dot.issuePending(f.owner, 3600);
	await dot.setLongLivedServerUrl(
		"https://dot.example/api/plugin-runtime/handle?token=pending",
	);
	await dot.recordDiscovery(credential("new-jti"));
	const state = await dot.externalState();
	const connection = { ...(await dot.current()), testEventIds: ["old-test"] };
	const rows = projectDotJourney({
		runtimeRunning: true,
		external: state,
		connection,
		dispatches: [
			{
				eventId: "old-test",
				attemptId: connection.attemptId,
				occurredAt: Date.now(),
				sourceReadAt: Date.now(),
				replyMessageId: "old-reply",
			},
		],
		now: Date.now(),
	});
	assert.equal(state.pending.pairingAttemptId, connection.attemptId);
	assert.equal(state.pending.pairingRequired, false);
	assert.equal(rows.rows[0].key, "waiting-subscription");
});

test("pending credential is limited to discovery, initial subscription and its exact read/reply proof", async (t) => {
	const f = await paired(t);
	const dot = new DotConnection(
		f.host,
		f.sendWebhook,
		new AbortController().signal,
	);
	f.host.capability = {
		issueExternal: async () => ({
			token: "pending",
			tokenId: "new-jti",
			issuedAt: 1,
			expiresAt: 2_000_000_000,
			refreshRecommendedAt: 1_900_000_000,
		}),
	};
	await dot.issuePending(f.owner, 3600);
	await dot.recordDiscovery(credential("new-jti"));
	const eventId = "dot_evt_" + "b".repeat(64);
	await dot.bindPendingVerification(eventId);
	await assert.rejects(
		dot.authorizeExternal(credential("new-jti"), "publish-image", eventId),
		/pending_operation/,
	);
	await assert.rejects(
		dot.authorizeExternal(credential("new-jti"), "pairing-unsubscribe"),
		/pending_operation/,
	);
	await dot.authorizeExternal(credential("new-jti"), "read", eventId);
	await dot.authorizeExternal(credential("new-jti"), "reply", eventId);
});

test("cancelling a replacement restores the current credential endpoint", async (t) => {
	const f = fixture(t);
	f.host.external.token = "";
	const previousEndpoint = {
		mode: "temporary-active",
		serverUrl: "https://temporary.example/mcp?token=current-token",
		generation: "temporary-current",
		startedAt: 10,
		expiresAt: 2_000_000_000_000,
		reachableAt: 11,
	};
	await f.host.storage.set(EXTERNAL_KEY, {
		v: 1,
		revision: 2,
		current: {
			kind: "signed",
			token: "current-token",
			tokenId: "jti-current",
			issuedAt: 1,
			expiresAt: 2_000_000_000,
			refreshRecommendedAt: 1_900_000_000,
		},
		pending: {
			kind: "pending",
			candidateId: "candidate",
			revision: 1,
			token: "pending-token",
			tokenId: "jti-pending",
			issuedAt: 1,
			expiresAt: 2_000_000_000,
			refreshRecommendedAt: 1_900_000_000,
			createdAt: 1,
			discoveredAt: null,
			pairingAttemptId: null,
			verificationEventId: null,
			verificationReadAt: null,
			verificationReplyAt: null,
			previousEndpoint,
		},
		endpoint: {
			...previousEndpoint,
			serverUrl: "https://temporary.example/mcp?token=pending-token",
		},
	});
	const dot = new DotConnection(
		f.host,
		f.sendWebhook,
		new AbortController().signal,
	);
	const restored = await dot.cancelPending();
	assert.equal(restored.pending, null);
	assert.deepEqual(restored.endpoint, previousEndpoint);
});

test("setup rows retain replacement cancellation and its owner action restores the healthy connection", async (t) => {
	const f = await paired(t);
	const dot = new DotConnection(
		f.host,
		f.sendWebhook,
		new AbortController().signal,
	);
	const old = await dot.externalState();
	const previousEndpoint = {
		mode: "long-lived",
		serverUrl: "https://old.example/mcp?token=old",
		reachableAt: Date.now(),
	};
	await f.host.storage.set(EXTERNAL_KEY, {
		...old,
		endpoint: previousEndpoint,
	});
	f.host.capability = {
		issueExternal: async () => ({
			token: "pending",
			tokenId: "new-jti",
			issuedAt: 1,
			expiresAt: 2_000_000_000,
			refreshRecommendedAt: 1_900_000_000,
		}),
	};
	await dot.issuePending(f.owner, 3600);
	await dot.setLongLivedServerUrl(
		"https://new.example/api/plugin-runtime/handle?token=pending",
	);
	const external = await dot.externalState();
	const connection = await dot.current();
	const now = Date.now();
	for (const [key, discoveredAt, candidateConnection] of [
		["waiting-discovery", null, connection],
		["pairing-not-started", now, null],
		[
			"pairing-expired",
			now,
			{
				...connection,
				pairedAt: null,
				subscription: null,
				pairingExpiresAt: now - 1,
			},
		],
		[
			"waiting-subscription",
			now,
			{
				...connection,
				pairedAt: null,
				subscription: null,
				pairingExpiresAt: now + 60_000,
			},
		],
	]) {
		for (const hasCurrent of [true, false]) {
			const rows = projectDotJourney({
				runtimeRunning: true,
				external: {
					...external,
					current: hasCurrent ? external.current : null,
					pending: {
						...external.pending,
						binding: undefined,
						discoveredAt,
						pairingRequired: true,
					},
				},
				connection: candidateConnection,
				dispatches: [],
				now,
			});
			assert.equal(rows.rows[0].key, key);
			assert.equal(
				rows.rows[0].actions?.some(
					(action) => action.action === "cancel-pending",
				) ?? false,
				hasCurrent,
				`${key}: only replacements need old-connection recovery`,
			);
		}
	}
	const before = await f.settings.actions["dot.status"]({}, undefined, f.owner);
	assert.ok(
		before.data.rows[0].actions.some(
			(action) => action.action === "cancel-pending",
		),
	);
	await f.settings.actions["dot.cancel-pending"]({}, undefined, f.owner);
	assert.equal((await dot.externalState()).pending, null);
	assert.deepEqual((await dot.externalState()).endpoint, previousEndpoint);
	assert.deepEqual((await dot.current()).subscription, connection.subscription);
});

for (const remainingLeaseMs of [-60_000, 24 * 60 * 60_000]) {
	test(`stopped temporary endpoint recovers through URL generation without renewing a dead lease (${remainingLeaseMs})`, async (t) => {
		const f = await paired(t);
		const now = Date.now();
		const subscription = structuredClone(
			f.records.get(CONNECTION_KEY).value.subscription,
		);
		const attemptId = f.records.get(CONNECTION_KEY).value.attemptId;
		await f.active.stop({ reason: "test-restart" });
		let issued = 0;
		f.host.capability = {
			issueExternal: async () => {
				issued++;
				return {
					token: "recovered-token",
					tokenId: "recovered-jti",
					issuedAt: Math.floor(now / 1000),
					expiresAt: Math.floor(now / 1000) + 86400 + 300,
					refreshRecommendedAt: Math.floor(now / 1000) + 86000,
					forwarding: {
						upstreamLoopbackOrigin: "http://127.0.0.1:5182",
						relativePath: "/api/plugin-runtime/handle",
						method: "POST",
					},
				};
			},
			inspectExternal: async () => ({
				usable: false,
				reason: "expired",
				refreshRecommended: true,
			}),
		};
		await f.host.storage.set(EXTERNAL_KEY, {
			v: 1,
			revision: 1,
			pending: null,
			current: {
				kind: "signed",
				token: "expired-token",
				tokenId: "old-jti",
				issuedAt: 1,
				expiresAt: Math.floor(now / 1000) - 1,
				refreshRecommendedAt: 1,
			},
			endpoint: {
				mode: "temporary-active",
				generation: "old-lease",
				startedAt: now - 3600_000,
				expiresAt: now + remainingLeaseMs,
				reachableAt: now - 3600_000,
				serverUrl: "https://old.example/mcp?token=expired-token",
			},
		});
		const originalStart = TemporaryEndpointController.prototype.start;
		let started;
		TemporaryEndpointController.prototype.start = async function (input) {
			started = input;
			return {
				generation: "new-lease",
				serverUrl: `https://new.example/mcp?token=${input.token}`,
				startedAt: now,
				expiresAt: now + input.ttlMs,
			};
		};
		t.after(() => {
			TemporaryEndpointController.prototype.start = originalStart;
		});
		f.active = await f.module.start(f.host);
		const status = await f.settings.actions["dot.status"](
			{},
			undefined,
			f.owner,
		);
		assert.equal(status.data.rows[0].key, "endpoint-unavailable");
		assert.match(status.data.rows[0].label, /临时入口/);
		assert.match(status.data.rows[0].detail, /创建临时入口/);
		assert.equal(
			status.data.rows[0].actions?.some(
				(a) => a.action === "refresh-credential",
			) ?? false,
			false,
		);
		const before = structuredClone(f.records.get(EXTERNAL_KEY));
		const staleRefresh = await f.settings.actions["dot.refresh-credential"](
			{},
			undefined,
			f.owner,
		);
		assert.equal(staleRefresh.render, "rows");
		assert.equal(staleRefresh.data.rows[0].key, "endpoint-unavailable");
		assert.equal(
			issued,
			0,
			"a stale refresh must not issue or cancel a candidate on an unavailable endpoint",
		);
		assert.deepEqual(f.records.get(EXTERNAL_KEY), before);
		const url = await f.settings.actions["dot.start-temporary"](
			{ input: { temporaryEndpointHours: "24" } },
			undefined,
			f.owner,
		);
		const recoveredToken = new URL(url.data).searchParams.get("token");
		assert.match(recoveredToken, /^[A-Za-z0-9_-]{43}$/);
		assert.equal(url.data, `https://new.example/mcp?token=${started.token}`);
		const recoveredId = f.records.get(EXTERNAL_KEY).value.pending.tokenId;
		const pluginRequest = (_f, body) =>
			f.active.webhook.handle({
				contributionId: "dot-mcp-ingress",
				request: {
					method: "POST",
					path: "mcp",
					query: { token: recoveredToken },
					headers: {},
					body,
				},
			});
		const pluginCall = (_f, name, args) =>
			pluginRequest(f, {
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name, arguments: args },
			});
		assert.equal(started.ttlMs, 24 * 60 * 60_000);
		assert.equal(
			issued,
			0,
			"plugin creates its own credential without Host issuance",
		);
		assert.equal(started.relativePath, "/mcp");
		assert.match(started.upstreamLoopbackOrigin, /^http:\/\/127\.0\.0\.1:\d+$/);
		assert.deepEqual(
			f.records.get(CONNECTION_KEY).value.subscription,
			subscription,
		);
		assert.equal(f.records.get(CONNECTION_KEY).value.attemptId, attemptId);
		const external = f.records.get(EXTERNAL_KEY).value;
		assert.equal(external.pending.pairingRequired, false);
		assert.equal(
			external.pending.discoveredAt,
			null,
			"new URL must still be discovered before candidate verification",
		);
		assert.equal(
			external.current.tokenId,
			"old-jti",
			"old state is retained until exact new candidate verification",
		);
		const discovery = await pluginRequest(
			f,
			{ jsonrpc: "2.0", id: 41, method: "server/discover", params: {} },
			"recovered-jti",
		);
		assert.equal(discovery.body.error, undefined);
		const message = await f.settings.actions["dot.show-instructions"](
			{},
			undefined,
			f.owner,
		);
		assert.equal(message.render, "text");
		const restored = f.records.get(CONNECTION_KEY).value;
		const subscribe = await pluginRequest(
			f,
			{
				jsonrpc: "2.0",
				id: 42,
				method: "events/subscribe",
				params: {
					name: "dot.summoned",
					arguments: {
						attempt_id: restored.attemptId,
						pairing_code: message.data.match(/pairing_code=([a-f0-9]+)/)[1],
					},
					delivery: {
						mode: "webhook",
						url: "https://callbacks.example/recovered",
						secret,
					},
					ttlMs: null,
				},
			},
			"recovered-jti",
		);
		assert.equal(
			subscribe.body.error,
			undefined,
			JSON.stringify(subscribe.body),
		);
		const dot = new DotConnection(
			f.host,
			f.sendWebhook,
			new AbortController().signal,
		);
		assert.deepEqual(
			(await dot.current()).subscription,
			subscription,
			"new subscription must not replace the current binding before proof",
		);
		await f.settings.actions["dot.roundtrip"]({}, undefined, f.owner);
		const testId = f.records.get(CONNECTION_KEY).value.testEventIds.at(-1);
		assert.equal(
			f.webhooks.filter((w) => w.data.eventId === testId).at(-1)?.url,
			"https://callbacks.example/recovered",
			"verification must reach the new ChatGPT connection",
		);
		await pluginCall(
			f,
			"cat_cafe_dot_read_source",
			{ event_id: testId },
			"recovered-jti",
		);
		assert.deepEqual(
			(await dot.current()).subscription,
			subscription,
			"source read alone cannot promote a callback",
		);
		const dispatch = f.records.get(`dot/dispatch/${testId}`).value;
		const wrong = await pluginCall(
			f,
			"cat_cafe_dot_reply",
			{ event_id: testId, content: "no nonce" },
			"recovered-jti",
		);
		assert.ok(wrong.body.error, "a reply without the nonce cannot promote");
		assert.deepEqual((await dot.current()).subscription, subscription);
		const replied = await pluginCall(
			f,
			"cat_cafe_dot_reply",
			{ event_id: testId, content: `ok ${dispatch.expectedNonce}` },
			"recovered-jti",
		);
		assert.equal(replied.body.error, undefined, JSON.stringify(replied.body));
		assert.equal(f.records.get(EXTERNAL_KEY).value.pending, null);
		assert.equal(
			f.records.get(EXTERNAL_KEY).value.current.tokenId,
			recoveredId,
		);
		assert.equal(
			(await dot.current()).subscription.url,
			"https://callbacks.example/recovered",
		);
	});
}
