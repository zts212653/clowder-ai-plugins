import assert from "node:assert/strict";
import test from "node:test";
import type { SharedConnectionView } from "./connection.js";
import type { DotConnectionState } from "./connection-state.js";
import { projectDotJourney } from "./journey-projection.js";
import type { Dispatch } from "./store.js";

const now = 1_800_000_000_000;
const shared = (
	deployment: SharedConnectionView["deployment"],
	state: SharedConnectionView["binding"]["state"],
): SharedConnectionView => ({
	deployment,
	binding: {
		state,
		revision: state === "unbound" ? 0 : 1,
		scope: { tools: 4, events: 1 },
	},
});
const activeShared = shared(
	{
		state: "configured",
		endpoint: "https://shared.example/mcp",
		principal: "gpt-pro",
	},
	"active",
);
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
	shared: activeShared,
	connection: null,
	dispatches: [],
	now,
} as const;

test("projects deployment, authorization, and pairing as separate stages", () => {
	assert.equal(
		stage({ ...base, runtimeRunning: false }),
		"runtime-unavailable",
	);
	assert.equal(
		stage({
			...base,
			shared: shared({ state: "missing-principal" }, "unbound"),
		}),
		"deployment-blocked",
	);
	assert.equal(
		stage({
			...base,
			shared: shared(
				{ state: "missing-endpoint", principal: "gpt-pro" },
				"active",
			),
		}),
		"deployment-blocked",
	);
	assert.equal(
		stage({
			...base,
			shared: shared(activeShared.deployment, "needs-confirmation"),
		}),
		"authorization-required",
	);
	assert.equal(stage(base), "pairing-not-started");
	const blocked = projectDotJourney({
		...base,
		shared: shared({ state: "missing-principal" }, "unbound"),
	});
	assert.doesNotMatch(blocked.rows[0]?.detail ?? "", /通用连接设置/);
	assert.match(blocked.rows[0]?.detail ?? "", /部署管理员/);
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
