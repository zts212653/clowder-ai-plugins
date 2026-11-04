import assert from "node:assert/strict";
import test from "node:test";
import type { DotConnectionState } from "./connection-state.js";
import type { DotExternalState } from "./external-state.js";
import { projectDotJourney } from "./journey-projection.js";
import type { Dispatch } from "./store.js";

const now = 1_800_000_000_000;
const currentExternal: DotExternalState = {
	v: 1,
	revision: 1,
	current: { kind: "signed", token: "token", tokenId: "jti", issuedAt: 1, expiresAt: 2_000_000_000, refreshRecommendedAt: 1_900_000_000 },
	pending: null,
	endpoint: { mode: "long-lived", serverUrl: "https://dot.example/mcp?token=token", reachableAt: now },
};
const pendingExternal = (discoveredAt: number | null): DotExternalState => ({
	...currentExternal,
	current: null,
	pending: {
		kind: "pending", candidateId: "candidate", revision: 1, token: "pending", tokenId: "pending-jti",
		issuedAt: 1, expiresAt: 2_000_000_000, refreshRecommendedAt: 1_900_000_000, createdAt: now,
		discoveredAt, pairingAttemptId: null, verificationEventId: null, verificationReadAt: null, verificationReplyAt: null,
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
	assert.equal(
		stage({ ...base, external: null }),
		"endpoint-choice",
	);
	assert.equal(
		stage({ ...base, external: pendingExternal(null) }),
		"waiting-discovery",
	);
	assert.equal(
		stage({ ...base, external: pendingExternal(now) }),
		"pairing-not-started",
	);
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
	assert.match(result.rows[0]?.detail ?? "", new RegExp(new Date(now + 60_000).toISOString()));
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

test("an expired signed current credential cannot borrow historical readiness and exposes renewal", () => {
	const expired: DotExternalState = {
		...currentExternal,
		current: { ...currentExternal.current!, expiresAt: 2 },
	};
	const subscribed = connection({
		pairedAt: now - 10_000,
		subscription: { id: "sub", url: "https://callback.example/dot", secret: "secret", expiresAt: null, verifiedAt: now - 10_000, previousSecret: null, rotationUntil: null },
		testEventIds: [`dot_evt_${"a".repeat(64)}`],
	});
	const result = projectDotJourney({ ...base, external: expired, connection: subscribed, dispatches: [dispatch({ sourceReadAt: now - 1_000, replyMessageId: "reply" })] });
	assert.equal(result.rows[0]?.key, "credential-unavailable");
	assert.ok(result.rows[0]?.actions?.some((candidate) => candidate.action === "refresh-credential"));
});
