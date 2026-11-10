import assert from "node:assert/strict";
import test from "node:test";
import { validateOperationRowsResult } from "@clowder-ai/plugin-contract";
import type { DotConnectionState } from "./connection-state.js";
import type { DotExternalState } from "./external-state.js";
import { projectDotJourney } from "./journey-projection.js";
import type { Dispatch } from "./store.js";

const now = 1_800_000_000_000;
const currentExternal: DotExternalState = {
	v: 1,
	revision: 1,
	current: {
		kind: "signed",
		token: "token",
		tokenId: "jti",
		issuedAt: 1,
		expiresAt: 2_000_000_000,
		refreshRecommendedAt: 1_900_000_000,
	},
	pending: null,
	endpoint: {
		mode: "long-lived",
		serverUrl: "https://dot.example/mcp?token=token",
		reachableAt: now,
	},
};
const pendingExternal = (discoveredAt: number | null): DotExternalState => ({
	...currentExternal,
	current: null,
	pending: {
		kind: "pending",
		candidateId: "candidate",
		revision: 1,
		token: "pending",
		tokenId: "pending-jti",
		issuedAt: 1,
		expiresAt: 2_000_000_000,
		refreshRecommendedAt: 1_900_000_000,
		createdAt: now,
		discoveredAt,
		pairingAttemptId: null,
		verificationEventId: null,
		verificationReadAt: null,
		verificationReplyAt: null,
	},
});
const connection = (
	overrides: Partial<DotConnectionState> = {},
): DotConnectionState => ({
	v: 1,
	revision: 1,
	ownerUserId: "owner",
	pluginInstanceId: "dot-one",
	agentKeyId: "plugin:key",
	attemptId: "attempt-one",
	pairingCode: "a".repeat(32),
	pairingExpiresAt: now + 30 * 60_000,
	pairedAt: null,
	pairedCallbackUrl: null,
	subscription: null,
	lastSourceReadAt: null,
	lastReplyAt: null,
	lastImageAt: null,
	revokedAt: null,
	testEventIds: [],
	...overrides,
});
const dispatch = (overrides: Partial<Dispatch> = {}): Dispatch => ({
	eventId: `dot_evt_${"a".repeat(64)}`,
	ownerUserId: "owner",
	threadId: "thread-one",
	sourceMessageId: "message-one",
	dispatchInvocationId: "test:nonce",
	attemptId: "attempt-one",
	agentKeyId: "plugin:key",
	occurredAt: now - 5_000,
	webhookAcknowledgedAt: null,
	sourceReadAt: null,
	replyMessageId: null,
	imagePublicationIds: [],
	connectionTest: true,
	expectedNonce: "a".repeat(16),
	deliveryError: null,
	...overrides,
});
const stage = (input: Parameters<typeof projectDotJourney>[0]) =>
	projectDotJourney(input).rows[0]?.key;
const base = {
	runtimeRunning: true,
	external: currentExternal,
	connection: null,
	dispatches: [],
	now,
} as const;

test("projects endpoint, ChatGPT discovery, and pairing as separate stages", () => {
	assert.equal(
		stage({ ...base, runtimeRunning: false }),
		"runtime-unavailable",
	);
	assert.equal(stage({ ...base, external: null }), "waiting-connection");
	assert.equal(
		stage({ ...base, external: pendingExternal(null) }),
		"waiting-discovery",
	);
	assert.equal(
		stage({ ...base, external: pendingExternal(now) }),
		"pairing-not-started",
	);
	assert.equal(
		projectDotJourney({ ...base, external: null }).rows[0]?.label,
		"待连接",
	);
	assert.equal(
		validateOperationRowsResult(
			{ actions: [] },
			projectDotJourney({ ...base, external: null }),
		).valid,
		true,
	);
});

test("keeps connection status separate from the setup tutorial", () => {
	const result = projectDotJourney({
		...base,
		external: pendingExternal(null),
	});
	const waiting = result.rows[0];
	assert.equal(waiting?.key, "waiting-discovery");
	assert.match(waiting?.detail ?? "", /尚未收到.*工具与事件扫描/);
	assert.doesNotMatch(
		waiting?.detail ?? "",
		/Add custom MCP server|No authentication/,
	);
	assert.deepEqual(waiting?.actions ?? [], []);
});

test("shows the absolute temporary endpoint expiry in the owner journey", () => {
	const temporary: DotExternalState = {
		...pendingExternal(null),
		endpoint: {
			mode: "temporary-active",
			serverUrl: "https://temporary.example/mcp?token=pending",
			generation: "temporary-one",
			startedAt: now - 1_000,
			expiresAt: now + 60_000,
			reachableAt: now,
		},
	};
	const result = projectDotJourney({ ...base, external: temporary });
	assert.equal(result.rows[0]?.key, "waiting-discovery");
	assert.match(result.rows[0]?.detail ?? "", /临时入口/);
	assert.match(
		result.rows[0]?.detail ?? "",
		new RegExp(new Date(now + 60_000).toISOString()),
	);
});

test("bounds waiting observation by both five minutes and the absolute pairing expiry", () => {
	const rows = projectDotJourney({
		...base,
		connection: connection({ pairingExpiresAt: now + 30_000 }),
	});
	assert.equal(rows.rows[0]?.key, "waiting-subscription");
	assert.equal(rows.pollUntil, now + 30_000);
});

test("derives verification progress, timeout diagnostics, and readiness only from current-attempt evidence", () => {
	const subscribed = connection({
		pairedAt: now - 10_000,
		subscription: {
			id: "sub-one",
			url: "https://callback.example/dot",
			secret: "secret",
			expiresAt: null,
			verifiedAt: now - 10_000,
			previousSecret: null,
			rotationUntil: null,
		},
		testEventIds: [`dot_evt_${"a".repeat(64)}`],
	});
	assert.equal(
		stage({ ...base, connection: subscribed }),
		"verification-required",
	);
	const pending = projectDotJourney({
		...base,
		connection: subscribed,
		dispatches: [dispatch()],
	});
	assert.equal(pending.rows[0]?.key, "verification-pending");
	assert.equal(pending.pollUntil, now + 55_000);
	assert.equal(
		stage({
			...base,
			connection: subscribed,
			dispatches: [dispatch({ deliveryError: "network" })],
		}),
		"verification-failed",
	);
	assert.equal(
		stage({
			...base,
			connection: subscribed,
			dispatches: [dispatch({ occurredAt: now - 61_000 })],
		}),
		"verification-timeout",
	);
	assert.equal(
		stage({
			...base,
			connection: subscribed,
			dispatches: [
				dispatch({ sourceReadAt: now - 1_000, replyMessageId: "reply-one" }),
			],
		}),
		"ready",
	);
	assert.equal(
		stage({
			...base,
			connection: subscribed,
			dispatches: [
				dispatch({
					attemptId: "old-attempt",
					sourceReadAt: now - 1_000,
					replyMessageId: "old-reply",
				}),
			],
		}),
		"verification-required",
	);
});

test("an expired signed credential points back to URL setup instead of borrowing historical readiness", () => {
	const expired: DotExternalState = {
		...currentExternal,
		current: { ...currentExternal.current!, expiresAt: 2 },
	};
	const subscribed = connection({
		pairedAt: now - 10_000,
		subscription: {
			id: "sub",
			url: "https://callback.example/dot",
			secret: "secret",
			expiresAt: null,
			verifiedAt: now - 10_000,
			previousSecret: null,
			rotationUntil: null,
		},
		testEventIds: [`dot_evt_${"a".repeat(64)}`],
	});
	const result = projectDotJourney({
		...base,
		external: expired,
		connection: subscribed,
		dispatches: [
			dispatch({ sourceReadAt: now - 1_000, replyMessageId: "reply" }),
		],
	});
	assert.equal(result.rows[0]?.key, "credential-unavailable");
	assert.match(result.rows[0]?.detail ?? "", /上方重新生成 Server URL/);
	assert.deepEqual(result.rows[0]?.actions ?? [], []);
});

test("an unavailable endpoint offers recovery rather than candidate cleanup or disconnect", () => {
	const external: DotExternalState = {
		...pendingExternal(now),
		current: currentExternal.current,
		endpoint: {
			mode: "temporary-expired",
			generation: "old",
			expiresAt: now - 1,
		},
	};
	const result = projectDotJourney({ ...base, external });
	assert.equal(result.rows[0]?.key, "endpoint-unavailable");
	assert.equal(
		result.rows[0]?.actions?.some((a) => a.action === "cancel-pending") ??
			false,
		false,
	);
	assert.equal(
		result.rows[0]?.actions?.some((a) => a.action === "disconnect") ?? false,
		false,
	);
	assert.match(result.rows[0]?.detail ?? "", /上方.*创建临时入口/);
});

test("a healthy replacement in progress needs no owner cleanup action", () => {
	const external: DotExternalState = {
		...pendingExternal(null),
		current: currentExternal.current,
	};
	const result = projectDotJourney({ ...base, external });
	assert.equal(result.rows[0]?.key, "waiting-discovery");
	assert.deepEqual(result.rows[0]?.actions ?? [], []);
});

test("a failed verification job cannot override endpoint or subscription recovery", () => {
	const result = projectDotJourney({
		...base,
		external: {
			...pendingExternal(now),
			endpoint: {
				mode: "temporary-expired",
				generation: "old",
				expiresAt: now - 1,
			},
		},
		verificationJob: {
			v: 1,
			key: "old",
			nonce: "old",
			stage: "failed",
			attempts: 1,
			error: "network",
		},
	});
	assert.equal(result.rows[0]?.key, "endpoint-unavailable");
	assert.deepEqual(result.rows[0]?.actions ?? [], []);
});

test("an expired candidate credential directs URL setup before waiting or stale verification failure", () => {
	const external = pendingExternal(null);
	const result = projectDotJourney({
		...base,
		external: { ...external, pending: { ...external.pending!, expiresAt: 1 } },
		verificationJob: {
			v: 1,
			key: "old",
			nonce: "old",
			stage: "failed",
			attempts: 1,
		},
	});
	assert.equal(result.rows[0]?.key, "credential-unavailable");
	assert.deepEqual(result.rows[0]?.actions ?? [], []);
});
