import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDotPlugin } from "../src/plugin-entrypoint.ts";
import { DotConnection } from "../src/connection.ts";
import { CONNECTION_KEY, EXTERNAL_KEY } from "../src/store.ts";
import { fixture, mcp } from "./fixture.mjs";

const secret = "whsec_" + Buffer.alloc(32, 3).toString("base64");

function credential(id) {
	return { sub: "installed-dot-1", cap: "dot-mcp", jti: id, iat: 1, exp: 2_000_000_000 };
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
	return request(f, {
		jsonrpc: "2.0",
		id,
		method: "tools/call",
		params: { name, arguments: args },
	}, jti);
}

test("pending signed credential promotes only from its exact discovery, pairing and roundtrip evidence", async (t) => {
	let sequence = 0;
	const f = fixture(t, {
		config: {
			longLivedServerUrlTemplate: "https://dot.example/mcp?token={token}",
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
			inspectExternal: async () => ({ usable: true, reason: "usable", refreshRecommended: false }),
		},
	});
	f.host.external.token = "";
	f.host.dataPath = await mkdtemp(join(tmpdir(), "dot-credential-test-"));
	t.after(() => rm(f.host.dataPath, { recursive: true, force: true }));
	f.module = createDotPlugin({ sendWebhook: f.sendWebhook });
	f.settings = await f.module.settings(f.host);
	f.active = await f.module.start(f.host);
	t.after(() => f.active.stop({ reason: "test" }));

	const presentation = await f.settings.actions["dot.use-long-lived"]({}, undefined, f.owner);
	assert.equal(presentation.data, "https://dot.example/mcp?token=signed-token-1");
	let external = f.records.get(EXTERNAL_KEY).value;
	assert.equal(external.current, null);
	assert.equal(external.pending.tokenId, "jti-1");

	await request(f, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, "jti-1");
	await f.settings.actions["dot.begin-pairing"]({}, undefined, f.owner);
	const connection = f.records.get(CONNECTION_KEY).value;
	await request(f, {
		jsonrpc: "2.0",
		id: 2,
		method: "events/subscribe",
		params: {
			name: "dot.summoned",
			arguments: { attempt_id: connection.attemptId, pairing_code: connection.pairingCode },
			delivery: { mode: "webhook", url: "https://callbacks.example/dot", secret },
			ttlMs: null,
		},
	}, "jti-1");
	await f.settings.actions["dot.roundtrip"]({}, undefined, f.owner);
	const afterTest = f.records.get(CONNECTION_KEY).value;
	const eventId = afterTest.testEventIds.at(-1);
	const dispatch = f.records.get(`dot/dispatch/${eventId}`).value;
	await call(f, "cat_cafe_dot_read_source", { event_id: eventId }, "jti-1");
	await call(f, "cat_cafe_dot_reply", { event_id: eventId, content: `ok ${dispatch.expectedNonce}` }, "jti-1");

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
		endpoint: { mode: "long-lived", serverUrl: "https://dot.example/mcp?token=pending-token", reachableAt: null },
	};
	await f.host.storage.set(EXTERNAL_KEY, external);
	const connection = {
		v: 1, revision: 1, ownerUserId: "owner", pluginInstanceId: f.host.pluginInstanceId,
		agentKeyId: "key", attemptId: "attempt", pairingCode: "a".repeat(32), pairingExpiresAt: Date.now() + 60_000,
		pairedAt: Date.now(), pairedCallbackUrl: "https://callbacks.example/dot",
		subscription: { id: "sub", url: "https://callbacks.example/dot", secret, expiresAt: null, verifiedAt: Date.now(), previousSecret: null, rotationUntil: null },
		lastSourceReadAt: null, lastReplyAt: null, lastImageAt: null, revokedAt: null, testEventIds: [],
	};
	await f.host.storage.set(CONNECTION_KEY, connection);
	const dot = new DotConnection(f.host, f.sendWebhook, new AbortController().signal);
	await dot.recordPendingEvidence(credential("jti-current"), external.pending.verificationEventId, "read");
	await dot.recordPendingEvidence(credential("jti-current"), external.pending.verificationEventId, "reply");
	const retained = f.records.get(EXTERNAL_KEY).value;
	assert.equal(retained.current.tokenId, "jti-current");
	assert.equal(retained.pending.tokenId, "jti-pending");
	assert.equal(retained.pending.verificationReadAt, null);
	assert.equal(retained.pending.verificationReplyAt, null);
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
	const dot = new DotConnection(f.host, f.sendWebhook, new AbortController().signal);
	const restored = await dot.cancelPending();
	assert.equal(restored.pending, null);
	assert.deepEqual(restored.endpoint, previousEndpoint);
});
