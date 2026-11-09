import assert from "node:assert/strict";
import test from "node:test";
import { DotConnection } from "../src/connection.ts";
import { EXTERNAL_KEY, CONNECTION_KEY } from "../src/store.ts";
import { fixture, paired } from "./fixture.mjs";

function binding(state, overrides = {}) {
	return {
		attemptId: state.attemptId,
		pairingCode: state.pairingCode,
		pairingExpiresAt: state.pairingExpiresAt,
		version: 1,
		pairedCallbackUrl: state.pairedCallbackUrl,
		pairedAt: state.pairedAt,
		subscription: state.subscription,
		...overrides,
	};
}
function endpoint(f, token, method = "server/discover", params = {}) {
	return f.active.webhook.handle({
		contributionId: "dot-mcp-ingress",
		request: {
			method: "POST",
			path: "mcp",
			query: { token },
			headers: {},
			body: { jsonrpc: "2.0", id: 1, method, params },
		},
	});
}
for (const mismatch of ["pairing", "binding"])
	test(`repairing a mismatched ${mismatch} keeps the original URL and current authority`, async (t) => {
		const f = await paired(t),
			dot = new DotConnection(
				f.host,
				f.sendWebhook,
				new AbortController().signal,
			);
		const { state } = await dot.issuePluginPending(f.owner);
		const pending = state.pending;
		const url = `https://dot.example/mcp?token=${pending.token}`;
		await dot.setLongLivedServerUrl(pending.candidateId, url);
		assert.equal((await endpoint(f, pending.token)).body.error, undefined);
		const captured = await dot.externalState(),
			originalCurrent = structuredClone(captured.current);
		await f.host.storage.set(EXTERNAL_KEY, {
			...captured,
			pending: {
				...captured.pending,
				pairingAttemptId:
					mismatch === "pairing"
						? "previous-attempt"
						: captured.pending.pairingAttemptId,
				binding:
					mismatch === "binding"
						? binding(f.records.get(CONNECTION_KEY).value, {
								attemptId: "previous-attempt",
							})
						: null,
				pairingRequired: false,
				verificationEventId: "stale-event",
				verificationReadAt: 1,
				verificationReplyAt: 1,
			},
		});
		const failedStatus = await f.settings.actions["dot.status"](
			{},
			undefined,
			f.owner,
		);
		assert.equal(failedStatus.data.rows[0].key, "candidate-pairing-mismatch");
		const result = await f.settings.actions["dot.repair-subscription"](
			{},
			undefined,
			f.owner,
		);
		const after = await dot.externalState(),
			identity = f.records.get(CONNECTION_KEY).value;
		assert.equal(result.render, "text");
		assert.match(result.data, new RegExp(`attempt_id=${identity.attemptId}`));
		assert.equal(identity.revokedAt, null);
		assert.equal(after.pending.token, pending.token);
		assert.equal(after.pending.candidateId, pending.candidateId);
		assert.equal(after.pending.discoveredAt, captured.pending.discoveredAt);
		assert.equal(after.endpoint.serverUrl, url);
		assert.deepEqual(after.current, originalCurrent);
		assert.equal(after.pending.binding, null);
		assert.equal(after.pending.verificationEventId, null);
		assert.equal(after.pending.verificationReplyAt, null);
		assert.equal((await endpoint(f, pending.token)).body.error, undefined);
	});

test("repairing an expired current subscription refreshes pairing intent without changing token or attempt", async (t) => {
	const f = await paired(t),
		dot = new DotConnection(
			f.host,
			f.sendWebhook,
			new AbortController().signal,
		);
	const identity = f.records.get(CONNECTION_KEY).value;
	const { state } = await dot.issuePluginPending(f.owner);
	const p = state.pending;
	const current = {
		kind: "plugin",
		pluginInstanceId: f.host.pluginInstanceId,
		token: p.token,
		tokenId: p.tokenId,
		issuedAt: p.issuedAt,
		expiresAt: null,
		refreshRecommendedAt: null,
		binding: binding(identity, {
			pairingExpiresAt: 1,
			subscription: { ...identity.subscription, expiresAt: 1 },
		}),
	};
	await f.host.storage.set(EXTERNAL_KEY, {
		...state,
		current,
		pending: null,
		endpoint: {
			mode: "long-lived",
			serverUrl: `https://dot.example/mcp?token=${p.token}`,
			reachableAt: 1,
		},
	});
	const result = await f.settings.actions["dot.repair-subscription"](
		{},
		undefined,
		f.owner,
	);
	const after = await dot.externalState();
	assert.equal(after.current.token, current.token);
	assert.equal(
		f.records.get(CONNECTION_KEY).value.attemptId,
		identity.attemptId,
	);
	assert.notEqual(
		after.current.binding.pairingCode,
		current.binding.pairingCode,
	);
	assert.ok(after.current.binding.pairingExpiresAt > Date.now());
	assert.ok(after.current.binding.version > current.binding.version);
	assert.match(
		result.data,
		new RegExp(`pairing_code=${after.current.binding.pairingCode}`),
	);
});

test("concurrent candidate replacement fences a delayed subscription repair", async (t) => {
	const f = await paired(t),
		dot = new DotConnection(
			f.host,
			f.sendWebhook,
			new AbortController().signal,
		);
	const { state } = await dot.issuePluginPending(f.owner);
	await dot.setLongLivedServerUrl(
		state.pending.candidateId,
		`https://dot.example/mcp?token=${state.pending.token}`,
	);
	const before = await dot.externalState();
	await f.host.storage.set(EXTERNAL_KEY, {
		...before,
		pending: { ...before.pending, pairingAttemptId: "old" },
	});
	const compare = f.host.storage.compareAndSet.bind(f.host.storage);
	let replaced = false,
		replacement;
	f.host.storage.compareAndSet = async (key, revision, next) => {
		if (
			key === EXTERNAL_KEY &&
			!replaced &&
			next.pending?.pairingAttemptId !== "old"
		) {
			replaced = true;
			const value = f.records.get(EXTERNAL_KEY).value;
			replacement = {
				...value,
				revision: value.revision + 1,
				pending: {
					...value.pending,
					candidateId: "replacement",
					revision: value.pending.revision + 1,
				},
			};
			await f.host.storage.set(EXTERNAL_KEY, replacement);
			return { applied: false };
		}
		return compare(key, revision, next);
	};
	await assert.rejects(
		f.settings.actions["dot.repair-subscription"]({}, undefined, f.owner),
		/dot_candidate_stale/,
	);
	assert.deepEqual(await dot.externalState(), replacement);
	assert.equal(f.records.get(CONNECTION_KEY).value.revokedAt, null);
});

test("disconnect between candidate repair and message generation prevents identity revival", async (t) => {
	const f = await paired(t),
		dot = new DotConnection(
			f.host,
			f.sendWebhook,
			new AbortController().signal,
		);
	const { state } = await dot.issuePluginPending(f.owner);
	await dot.setLongLivedServerUrl(
		state.pending.candidateId,
		`https://dot.example/mcp?token=${state.pending.token}`,
	);
	const before = await dot.externalState();
	await f.host.storage.set(EXTERNAL_KEY, {
		...before,
		pending: { ...before.pending, pairingAttemptId: "old" },
	});
	const compare = f.host.storage.compareAndSet.bind(f.host.storage);
	let disconnected = false,
		revoked;
	f.host.storage.compareAndSet = async (key, revision, next) => {
		const result = await compare(key, revision, next);
		if (
			key === EXTERNAL_KEY &&
			result.applied &&
			!disconnected &&
			next.pending?.verificationGeneration
		) {
			disconnected = true;
			await dot.revokeExternal();
			await dot.disconnect(f.owner);
			revoked = structuredClone(f.records.get(CONNECTION_KEY).value);
		}
		return result;
	};
	await assert.rejects(
		f.settings.actions["dot.repair-subscription"]({}, undefined, f.owner),
		/dot_repair_stale/,
	);
	assert.deepEqual(f.records.get(CONNECTION_KEY).value, revoked);
	assert.equal((await dot.externalState()).pending, null);
});

test("late repair rejection must not revoke the shared existing identity after candidate replacement", async (t) => {
	const f = await paired(t),
		dot = new DotConnection(
			f.host,
			f.sendWebhook,
			new AbortController().signal,
		);
	const { state } = await dot.issuePluginPending(f.owner);
	await dot.setLongLivedServerUrl(
		state.pending.candidateId,
		`https://dot.example/mcp?token=${state.pending.token}`,
	);
	const before = await dot.externalState();
	await f.host.storage.set(EXTERNAL_KEY, {
		...before,
		pending: { ...before.pending, pairingAttemptId: "stale-attempt" },
	});
	const original = structuredClone(f.records.get(CONNECTION_KEY).value);
	const compare = f.host.storage.compareAndSet.bind(f.host.storage);
	let replaced = false,
		replacement;
	f.host.storage.compareAndSet = async (key, revision, next) => {
		const result = await compare(key, revision, next);
		if (key === CONNECTION_KEY && result.applied && !replaced) {
			replaced = true;
			replacement = await dot.issuePluginPending(f.owner);
			await dot.setLongLivedServerUrl(
				replacement.state.pending.candidateId,
				`https://dot.example/mcp?token=${replacement.issued.token}`,
			);
		}
		return result;
	};
	await assert.rejects(
		f.settings.actions["dot.repair-subscription"]({}, undefined, f.owner),
		/dot_repair_stale/,
	);
	assert.equal(
		(await dot.externalState()).pending.candidateId,
		replacement.state.pending.candidateId,
	);
	assert.equal(
		f.records.get(CONNECTION_KEY).value.revokedAt,
		null,
		"late old repair must not revoke the formal/shared identity",
	);
	assert.equal((await dot.current()).attemptId, original.attemptId);
});

test("an interrupted first setup retains a retryable unpaired identity without granting old or new tokens business access", async (t) => {
	const f = fixture(t);
	f.host.external.token = undefined;
	const dot = new DotConnection(
		f.host,
		f.sendWebhook,
		new AbortController().signal,
	);
	const original = await dot.issuePluginPending(f.owner);
	await dot.setLongLivedServerUrl(
		original.state.pending.candidateId,
		`https://dot.example/mcp?token=${original.issued.token}`,
	);
	const compare = f.host.storage.compareAndSet.bind(f.host.storage);
	let replacement;
	f.host.storage.compareAndSet = async (key, revision, next) => {
		const result = await compare(key, revision, next);
		if (key === CONNECTION_KEY && result.applied && !replacement) {
			replacement = await dot.issuePluginPending(f.owner);
			await dot.setLongLivedServerUrl(
				replacement.state.pending.candidateId,
				`https://dot.example/mcp?token=${replacement.issued.token}`,
			);
		}
		return result;
	};
	await assert.rejects(
		dot.within(f.owner, () => dot.repairSubscription(f.owner)),
		/dot_repair_stale/,
	);
	const identity = f.records.get(CONNECTION_KEY).value;
	assert.equal(identity.revokedAt, null);
	assert.equal(identity.pairedAt, null);
	await assert.rejects(dot.ready(), /dot_subscription_required/);
	await assert.rejects(
		dot.authenticatePluginToken(original.issued.token),
		/dot_mcp_unauthorized/,
	);
	const newToken = await dot.authenticatePluginToken(replacement.issued.token);
	await assert.rejects(
		dot.authorizeExternal(newToken, "business"),
		/dot_pending_operation_rejected/,
	);
	const retried = await dot.within(f.owner, () =>
		dot.repairSubscription(f.owner),
	);
	assert.match(
		retried.instructions,
		new RegExp(`attempt_id=${identity.attemptId}`),
	);
	assert.equal(
		f.records.get(CONNECTION_KEY).value.attemptId,
		identity.attemptId,
	);
});
