import assert from "node:assert/strict";
import test from "node:test";
import { DotConnection } from "../src/connection.ts";
import { CONNECTION_KEY, EXTERNAL_KEY } from "../src/store.ts";
import { paired, delivery } from "./fixture.mjs";

async function protectedFixture(t) {
	const f = await paired(t);
	const state = f.records.get(CONNECTION_KEY).value;
	f.formal = {
		kind: "plugin",
		pluginInstanceId: f.host.pluginInstanceId,
		token: "formal-secret",
		tokenId: "formal",
		issuedAt: 1,
		expiresAt: null,
		refreshRecommendedAt: null,
		binding: {
			attemptId: state.attemptId,
			pairingCode: state.pairingCode,
			pairingExpiresAt: state.pairingExpiresAt,
			version: 1,
			pairedAt: state.pairedAt,
			pairedCallbackUrl: state.pairedCallbackUrl,
			subscription: state.subscription,
		},
	};
	f.lease = {
		mode: "temporary-active",
		serverUrl: "https://formal.example/mcp",
		generation: "formal-lease",
		startedAt: 1,
		expiresAt: Date.now() + 60000,
		reachableAt: 1,
	};
	await f.host.storage.set(EXTERNAL_KEY, {
		v: 1,
		revision: 1,
		current: f.formal,
		pending: null,
		endpoint: f.lease,
	});
	f.dot = new DotConnection(
		f.host,
		f.sendWebhook,
		new AbortController().signal,
	);
	return f;
}
for (const fault of [
	"lease-expired",
	"lease-stopped",
	"absent",
	"credential-expired",
	"wrong-instance",
])
	test(`business dispatch rejects an unusable formal return path: ${fault}`, async (t) => {
		const f = await protectedFixture(t);
		const external = f.records.get(EXTERNAL_KEY).value;
		if (fault === "lease-expired") external.endpoint.expiresAt = Date.now() - 1;
		if (fault === "lease-stopped")
			external.endpoint = {
				mode: "temporary-expired",
				generation: "formal-lease",
				expiresAt: Date.now() + 60000,
			};
		if (fault === "absent") external.endpoint = { mode: "absent" };
		if (fault === "credential-expired")
			external.current.expiresAt = Math.floor(Date.now() / 1000) - 1;
		if (fault === "wrong-instance")
			external.current.pluginInstanceId = "another-installation";
		await assert.rejects(
			f.active.deliver(delivery(f)),
			/dot_(endpoint|credential)_unavailable/,
		);
		assert.equal(
			f.webhooks.filter((w) => w.data.name === "dot.summoned").length,
			0,
		);
	});
test("candidate ingress does not replace the still-working formal return path", async (t) => {
	const f = await protectedFixture(t);
	const external = f.records.get(EXTERNAL_KEY).value;
	external.pending = {
		kind: "pending",
		issuer: "plugin",
		pluginInstanceId: f.host.pluginInstanceId,
		token: "candidate-secret",
		tokenId: "candidate",
		issuedAt: 1,
		expiresAt: null,
		refreshRecommendedAt: null,
		candidateId: "candidate-1",
		revision: 1,
		createdAt: 1,
		discoveredAt: null,
		pairingAttemptId: null,
		pairingRequired: true,
		binding: null,
		verificationEventId: null,
		verificationReadAt: null,
		verificationReplyAt: null,
		previousEndpoint: f.lease,
	};
	external.endpoint = {
		mode: "temporary-expired",
		generation: "new-lease",
		expiresAt: 1,
	};
	await f.active.deliver(delivery(f));
	assert.equal(
		f.webhooks.filter((w) => w.data.name === "dot.summoned").length,
		1,
	);
	external.pending.previousEndpoint = {
		mode: "temporary-expired",
		generation: "formal-lease",
		expiresAt: 1,
	};
	external.endpoint = {
		mode: "long-lived",
		serverUrl: "https://candidate.example/mcp",
		reachableAt: 1,
	};
	await assert.rejects(
		f.active.deliver(delivery(f, "second")),
		/dot_endpoint_unavailable/,
	);
});
test("formal long-lived and legacy connections retain their compatible delivery path", async (t) => {
	const f = await protectedFixture(t);
	f.records.get(EXTERNAL_KEY).value.endpoint = {
		mode: "long-lived",
		serverUrl: "https://formal.example/mcp",
		reachableAt: 1,
	};
	await f.active.deliver(delivery(f));
	f.records.get(EXTERNAL_KEY).value.current = {
		kind: "legacy",
		recordRef: "host.external",
	};
	f.records.get(EXTERNAL_KEY).value.endpoint = { mode: "absent" };
	await f.active.deliver(delivery(f, "legacy"));
});

test("Host-revoked signed credentials reject dispatch even before their local expiry", async (t) => {
	const f = await protectedFixture(t);
	const external = f.records.get(EXTERNAL_KEY).value;
	external.current = {
		...f.formal,
		kind: "signed",
		expiresAt: Math.floor(Date.now() / 1000) + 3600,
		refreshRecommendedAt: Math.floor(Date.now() / 1000) + 1800,
	};
	delete external.current.pluginInstanceId;
	f.host.capability = {
		inspectExternal: async () => ({
			usable: false,
			reason: "revoked",
			refreshRecommended: false,
		}),
	};
	await assert.rejects(
		f.active.deliver(delivery(f)),
		/dot_credential_unavailable/,
	);
	assert.equal(
		f.webhooks.filter((w) => w.data.name === "dot.summoned").length,
		0,
	);
});
test("an ingress expiring during the source read cannot receive a successful webhook receipt", async (t) => {
	const f = await protectedFixture(t);
	const get = f.host.messaging.get;
	f.host.messaging.get = async (id) => {
		const result = await get(id);
		f.records.get(EXTERNAL_KEY).value.endpoint = {
			mode: "temporary-expired",
			generation: "formal-lease",
			expiresAt: 1,
		};
		return result;
	};
	await assert.rejects(
		f.active.deliver(delivery(f)),
		/dot_endpoint_unavailable/,
	);
	assert.equal(
		f.webhooks.filter((w) => w.data.name === "dot.summoned").length,
		0,
	);
});

function stageSavedTemporary(f, candidateMode = "long-lived") {
	const external = f.records.get(EXTERNAL_KEY).value;
	external.pending = {
		kind: "pending",
		issuer: "plugin",
		pluginInstanceId: f.host.pluginInstanceId,
		token: "candidate-secret",
		tokenId: "candidate",
		issuedAt: 1,
		expiresAt: null,
		refreshRecommendedAt: null,
		candidateId: "candidate-1",
		revision: 1,
		createdAt: 1,
		discoveredAt: null,
		pairingAttemptId: null,
		pairingRequired: true,
		binding: null,
		verificationEventId: null,
		verificationReadAt: null,
		verificationReplyAt: null,
		previousEndpoint: f.lease,
	};
	external.endpoint =
		candidateMode === "long-lived"
			? {
					mode: "long-lived",
					serverUrl: "https://candidate.example/mcp",
					reachableAt: 1,
				}
			: {
					...f.lease,
					generation: "candidate-lease",
					serverUrl: "https://candidate.example/mcp",
				};
	return external;
}

for (const candidateMode of ["long-lived", "temporary-active"])
	test(`restart expires the saved formal temporary lease while ${candidateMode} is pending`, async (t) => {
		const f = await protectedFixture(t);
		stageSavedTemporary(f, candidateMode);
		await f.active.stop({ reason: "restart" });
		f.active = await f.module.start(f.host);
		const state = await f.dot.externalState();
		assert.equal(state.pending.previousEndpoint.mode, "temporary-expired");
		assert.equal(state.pending.previousEndpoint.generation, "formal-lease");
		assert.equal(
			state.endpoint.mode,
			candidateMode === "long-lived" ? "long-lived" : "temporary-expired",
		);
		await assert.rejects(
			f.active.deliver(delivery(f, "after-restart")),
			/dot_endpoint_unavailable/,
		);
		await f.dot.cancelPending();
		assert.equal(
			(await f.dot.externalState()).endpoint.mode,
			"temporary-expired",
		);
		await assert.rejects(
			f.active.deliver(delivery(f, "after-cancel")),
			/dot_endpoint_unavailable/,
		);
		assert.equal(
			f.webhooks.filter((w) => w.data.name === "dot.summoned").length,
			0,
		);
	});

test("lease termination expires a matching saved predecessor but cannot expire a replacement generation", async (t) => {
	const f = await protectedFixture(t);
	stageSavedTemporary(f, "temporary-active");
	await f.dot.expireTemporary("formal-lease");
	let state = await f.dot.externalState();
	assert.equal(state.pending.previousEndpoint.mode, "temporary-expired");
	assert.equal(state.endpoint.mode, "temporary-active");
	assert.equal(state.endpoint.generation, "candidate-lease");
	await f.dot.expireTemporary("retired-unrelated-lease");
	state = await f.dot.externalState();
	assert.equal(state.endpoint.mode, "temporary-active");
	assert.equal(state.endpoint.generation, "candidate-lease");
});
