import assert from "node:assert/strict";
import test from "node:test";
import { createDotPlugin } from "../src/plugin-entrypoint.ts";
import { fixture } from "./fixture.mjs";
import { DotConnection } from "../src/connection.ts";
import { TemporaryEndpointController } from "../src/temporary-endpoint.ts";

const path = "/api/plugins/official.chatgpt-dot/mcp";

async function setup(t, customSecret) {
	const f = fixture(t, {
		config: {
			endpointMode: "long-lived",
			longLivedServerUrlTemplate: `https://dot.example${path}?token={token}`,
		},
	});
	f.host.capability = {
		issueExternal: async () => assert.fail("Dot owns its external credential"),
		inspectExternal: async () =>
			assert.fail("Host must not inspect Dot credentials"),
	};
	if (customSecret !== undefined) f.host.secrets.get = async () => customSecret;
	let now = Date.now();
	const makeModule = () =>
		createDotPlugin({ sendWebhook: f.sendWebhook, now: () => now });
	let module = makeModule();
	let active = await module.start(f.host);
	t.after(async () => active.stop({ reason: "test" }));
	const generated = await active.actions["dot.use-long-lived"](
		{
			input: {
				longLivedServerUrlTemplate: `https://dot.example${path}?token={token}`,
			},
		},
		undefined,
		f.owner,
	);
	const url = new URL(generated.data);
	const token = url.searchParams.get("token");
	const request = (method, params, provided = token) =>
		active.webhook.handle({
			contributionId: "dot-mcp-ingress",
			request: {
				method: "POST",
				path: "mcp",
				query: { token: provided },
				headers: {},
				body: { jsonrpc: "2.0", id: 1, method, params },
			},
		});
	return {
		f,
		url,
		token,
		request,
		get active() {
			return active;
		},
		advance() {
			now += 365 * 86400_000;
		},
		async restart() {
			await active.stop({ reason: "test" });
			module = makeModule();
			active = await module.start(f.host);
		},
	};
}

async function completePairing(x) {
	assert.equal((await x.request("server/discover", {})).status, 200);
	const message = await x.active.actions["dot.show-instructions"](
		{},
		undefined,
		x.f.owner,
	);
	const attempt = message.data.match(/attempt_id=([^，]+)/)[1];
	const code = message.data.match(/pairing_code=([a-f0-9]+)/)[1];
	const result = await x.request("events/subscribe", {
		name: "dot.summoned",
		arguments: { attempt_id: attempt, pairing_code: code },
		delivery: {
			mode: "webhook",
			url: "https://callbacks.example/plugin-owned",
			secret: "whsec_" + Buffer.alloc(32, 7).toString("base64"),
		},
		ttlMs: null,
	});
	assert.equal(result.body.error, undefined);
	await x.active.actions["dot.roundtrip"]({}, undefined, x.f.owner);
	const id =
		x.f.records.get("dot/external/v1").value.pending.verificationEventId;
	assert.equal(
		(
			await x.request("tools/call", {
				name: "cat_cafe_dot_read_source",
				arguments: { event_id: id },
			})
		).body.error,
		undefined,
	);
	const nonce = x.f.records.get(`dot/dispatch/${id}`).value.expectedNonce;
	assert.equal(
		(
			await x.request("tools/call", {
				name: "cat_cafe_dot_reply",
				arguments: { event_id: id, content: `ok ${nonce}` },
			})
		).body.error,
		undefined,
	);
}

test("plugin-owned URL authenticates without a Host credential and rejects missing or wrong tokens", async (t) => {
	const x = await setup(t);
	assert.equal(x.url.pathname, path);
	assert.equal((await x.request("server/discover", {}, "wrong")).status, 401);
	assert.equal((await x.request("server/discover", {}, null)).status, 401);
	assert.equal((await x.request("server/discover", {})).status, 200);
	const external = x.f.records.get("dot/external/v1").value;
	assert.equal(external.pending.issuer, "plugin");
	assert.equal(external.pending.expiresAt, null);
});

test("a retained URL generated before pairing never authorizes a different installation", async (t) => {
	const x = await setup(t);
	assert.equal(x.f.records.has("dot/connection/v1"),false);
	await x.active.stop({reason:"uninstall"});
	x.f.host.pluginInstanceId = "replacement-installation";
	const next = await createDotPlugin({sendWebhook:x.f.sendWebhook}).start(x.f.host);
	t.after(()=>next.stop({reason:"test"}));
	const result = await next.webhook.handle({contributionId:"dot-mcp-ingress",request:{method:"POST",path:"mcp",query:{token:x.token},headers:{},body:{jsonrpc:"2.0",id:1,method:"server/discover",params:{}}}});
	assert.equal(result.status,401);
});

test("same plugin credential and callback survive time and restart, then explicit disconnect denies old requests", async (t) => {
	const x = await setup(t);
	await completePairing(x);
	assert.equal(x.f.records.get("dot/external/v1").value.current.kind, "plugin");
	x.advance();
	await x.restart();
	assert.equal(
		(await x.active.actions["dot.use-long-lived"]({}, undefined, x.f.owner))
			.data,
		x.url.toString(),
	);
	assert.equal((await x.request("server/discover", {})).status, 200);
	assert.equal(
		x.f.records.get("dot/external/v1").value.current.binding.subscription.url,
		"https://callbacks.example/plugin-owned",
	);
	await x.active.actions["dot.disconnect"]({}, undefined, x.f.owner);
	assert.equal((await x.request("server/discover", {})).status, 401);
	await x.restart();
	assert.equal((await x.request("server/discover", {})).status, 401);
});

for (const recovery of ["change", "clear"]) {
	test(`revoked saved custom key remains denied after restart and recovers by ${recovery}`, async (t) => {
		const old = "r".repeat(43), replacement = "s".repeat(43);
		const x = await setup(t, old);
		await completePairing(x);
		await x.active.actions["dot.disconnect"]({}, undefined, x.f.owner);
		assert.equal((await x.request("server/discover", {})).status, 401);
		await x.restart();
		const input = { input: { longLivedServerUrlTemplate: `https://dot.example${path}?token={token}` } };
		const before = structuredClone(x.f.records.get("dot/external/v1"));
		await assert.rejects(x.active.actions["dot.use-long-lived"](input, undefined, x.f.owner), /dot_mcp_token_revoked.*更换.*清空/);
		assert.deepEqual(x.f.records.get("dot/external/v1"), before);
		x.f.host.secrets.get = async () => recovery === "change" ? replacement : undefined;
		const generated = await x.active.actions["dot.use-long-lived"](input, undefined, x.f.owner);
		const token = new URL(generated.data).searchParams.get("token");
		assert.notEqual(token, old);
		if (recovery === "change") assert.equal(token, replacement);
		await completePairing({ ...x, request: (method, params) => x.request(method, params, token) });
		assert.equal((await x.request("server/discover", {}, old)).status, 401);
		await x.restart();
		assert.equal((await x.request("server/discover", {}, token)).status, 200);
		assert.equal((await x.request("server/discover", {}, old)).status, 401);
		await x.active.actions["dot.disconnect"]({}, undefined, x.f.owner);
		x.f.host.secrets.get = async () => old;
		await x.restart();
		await assert.rejects(x.active.actions["dot.use-long-lived"](input, undefined, x.f.owner), /dot_mcp_token_revoked/);
	});
}

test("cancelled custom candidate stays retired across restart without discarding its revocation history", async (t) => {
	const old = "r".repeat(43);
	const x = await setup(t, old);
	await x.restart();
	assert.equal((await x.request("server/discover", {})).status, 200);
	await x.active.actions["dot.cancel-pending"]({}, undefined, x.f.owner);
	await x.restart();
	const input = { input: { longLivedServerUrlTemplate: `https://dot.example${path}?token={token}` } };
	await assert.rejects(x.active.actions["dot.use-long-lived"](input, undefined, x.f.owner), /dot_mcp_token_revoked/);
	assert.equal((await x.request("server/discover", {})).status, 401);
});

test("promotion retires the replaced custom key and cancellation retires only the candidate", async (t) => {
	const old = "r".repeat(43), next = "s".repeat(43), cancelled = "t".repeat(43);
	const x = await setup(t, old);
	await completePairing(x);
	const input = { input: { longLivedServerUrlTemplate: `https://dot.example${path}?token={token}` } };
	x.f.host.secrets.get = async () => next;
	await x.active.actions["dot.refresh-credential"](input, undefined, x.f.owner);
	assert.equal((await x.request("server/discover", {}, old)).status, 200);
	await completePairing({ ...x, request: (method, params) => x.request(method, params, next) });
	assert.equal((await x.request("server/discover", {}, old)).status, 401);
	x.f.host.secrets.get = async () => cancelled;
	await x.active.actions["dot.refresh-credential"](input, undefined, x.f.owner);
	await x.active.actions["dot.cancel-pending"]({}, undefined, x.f.owner);
	await x.restart();
	for (const secret of [old, cancelled]) {
		x.f.host.secrets.get = async () => secret;
		await assert.rejects(x.active.actions["dot.refresh-credential"](input, undefined, x.f.owner), /dot_mcp_token_revoked/);
		assert.equal((await x.request("server/discover", {}, secret)).status, 401);
	}
	assert.equal((await x.request("server/discover", {}, next)).status, 200);
	assert.equal(x.f.records.get("dot/external/v1").value.current.binding.subscription.url, "https://callbacks.example/plugin-owned");
});

test("explicit setup after disconnect supports discovery before the next pairing step", async (t) => {
	const x=await setup(t);
	await completePairing(x);
	await x.active.actions["dot.disconnect"]({},undefined,x.f.owner);
	const generated=await x.active.actions["dot.use-long-lived"]({input:{longLivedServerUrlTemplate:`https://dot.example${path}?token={token}`}},undefined,x.f.owner);
	const token=new URL(generated.data).searchParams.get("token");
	assert.notEqual(token,x.token);
	assert.equal((await x.request("server/discover",{},x.token)).status,401);
	assert.equal((await x.request("server/discover",{},token)).status,200);
	assert.ok((await x.request("tools/call",{name:"cat_cafe_dot_ask",arguments:{content:"denied"}},token)).body.error);
	await completePairing({...x,request:(method,params)=>x.request(method,params,token)});
});

test("cancelling while local key preparation is in flight prevents a late credential write", async (t) => {
	const x=await setup(t);
	let enter,release;
	const entered=new Promise(resolve=>enter=resolve);
	x.f.host.secrets.get=async()=>{enter();return new Promise(resolve=>release=resolve)};
	const generation=x.active.actions["dot.refresh-credential"]({input:{longLivedServerUrlTemplate:`https://dot.example${path}?token={token}`}},undefined,x.f.owner);
	await entered;
	await x.active.actions["dot.cancel-pending"]({},undefined,x.f.owner);
	release(undefined);
	await assert.rejects(generation,/stale/);
	assert.equal(x.f.records.get("dot/external/v1").value.pending,null);
});

test("temporary transport targets the plugin's authenticated loopback; cancel and stop preserve their boundaries", async (t) => {
	const x = await setup(t);
	x.f.host.secrets.get = async () => "s".repeat(43);
	const original = TemporaryEndpointController.prototype.start;
	let input;
	TemporaryEndpointController.prototype.start = async function (value) {
		input = value;
		return {
			generation: "fixture",
			serverUrl: `https://temp.example/mcp?token=${value.token}`,
			startedAt: Date.now(),
			expiresAt: Date.now() + value.ttlMs,
		};
	};
	t.after(() => {
		TemporaryEndpointController.prototype.start = original;
	});
	await x.active.actions["dot.start-temporary"](
		{ input: { temporaryEndpointHours: "1" } },
		undefined,
		x.f.owner,
	);
	assert.equal(input.relativePath, "/mcp");
	assert.notEqual(input.token, "s".repeat(43), "temporary leases get distinct keys rather than reusing a saved long-lived key");
	const send = () =>
		fetch(`${input.upstreamLoopbackOrigin}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${input.token}`,
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "server/discover",
				params: {},
			}),
		});
	assert.equal((await send()).status, 200);
	await x.active.actions["dot.cancel-pending"]({}, undefined, x.f.owner);
	assert.equal(
		(await send()).status,
		401,
		"cancel must retire a candidate without killing the active transport",
	);
	await x.active.stop({ reason: "test" });
	await assert.rejects(send(), /fetch failed/);
});

test("declared custom secret is actually used; caller principal and credential fields never authorize a request", async (t) => {
	const x = await setup(t);
	await x.active.actions["dot.cancel-pending"]({}, undefined, x.f.owner);
	const secret = "s".repeat(43);
	x.f.host.secrets.get = async (name) =>
		name === "externalMcpToken" ? secret : undefined;
	const result = await x.active.actions["dot.use-long-lived"](
		{
			input: {
				longLivedServerUrlTemplate: `https://dot.example${path}?token={token}`,
			},
		},
		undefined,
		x.f.owner,
	);
	assert.equal(new URL(result.data).searchParams.get("token"), secret);
	const bad = await x.active.webhook.handle({
		contributionId: "dot-mcp-ingress",
		request: {
			method: "POST",
			path: "mcp",
			query: { token: "wrong" },
			headers: {},
			principal: { kind: "owner", id: "owner" },
			body: { jsonrpc: "2.0", id: 1, method: "server/discover", params: {} },
		},
	});
	assert.equal(bad.status, 401);
	assert.equal((await x.request("server/discover", {}, secret)).status, 200);
	const conflict = await x.active.webhook.handle({
		contributionId: "dot-mcp-ingress",
		request: {
			method: "POST",
			path: "mcp",
			query: { token: secret },
			headers: { "x-dot-access-token": "wrong" },
			body: { jsonrpc: "2.0", id: 1, method: "server/discover", params: {} },
		},
	});
	assert.equal(conflict.status, 401);
});

test("explicit local rotation stages a new key without invalidating the formal key, and invalid input does not mutate state", async (t) => {
	const x = await setup(t);
	await completePairing(x);
	const before = structuredClone(x.f.records.get("dot/external/v1"));
	await assert.rejects(
		x.active.actions["dot.refresh-credential"](
			{ input: { longLivedServerUrlTemplate: "invalid" } },
			undefined,
			x.f.owner,
		),
		/template/,
	);
	assert.deepEqual(x.f.records.get("dot/external/v1"), before);
	const result = await x.active.actions["dot.refresh-credential"](
		{
			input: {
				longLivedServerUrlTemplate: `https://dot.example${path}?token={token}`,
			},
		},
		undefined,
		x.f.owner,
	);
	const next = new URL(result.data).searchParams.get("token");
	assert.notEqual(next, x.token);
	assert.equal((await x.request("server/discover", {})).status, 200);
	assert.equal((await x.request("server/discover", {}, next)).status, 200);
	await x.active.actions["dot.cancel-pending"]({}, undefined, x.f.owner);
	assert.equal((await x.request("server/discover", {}, next)).status, 401);
	assert.equal((await x.request("server/discover", {})).status, 200);
});

test("public URL templates validate the token query without imposing an internal route on a reverse proxy", async (t) => {
	const x = await setup(t);
	await completePairing(x);
	const before = structuredClone(x.f.records.get("dot/external/v1"));
	for (const query of [
		"wrong={token}",
		"token=fixed&other={token}",
		"token={token}&token=fixed",
	]) {
		await assert.rejects(
			x.active.actions["dot.refresh-credential"](
				{
					input: {
						longLivedServerUrlTemplate: `https://dot.example/mcp?${query}`,
					},
				},
				undefined,
				x.f.owner,
			),
			/template/,
		);
		assert.deepEqual(x.f.records.get("dot/external/v1"), before);
	}
	const result = await x.active.actions["dot.refresh-credential"](
		{
			input: {
				longLivedServerUrlTemplate: "https://dot.example/mcp?token={token}",
			},
		},
		undefined,
		x.f.owner,
	);
	assert.equal(new URL(result.data).pathname, "/mcp");
	assert.equal(
		new URL(result.data).searchParams.get("token"),
		x.f.records.get("dot/external/v1").value.pending.token,
	);
});

for (const reauthorize of [false, true])
	test(`local callback renewal rejects a CAS retry after authority changes (reauthorize=${reauthorize})`, async (t) => {
		const x = await setup(t);
		await completePairing(x);
		const formal = x.f.records.get("dot/external/v1").value.current.binding;
		const lateSecret = "whsec_" + Buffer.alloc(32, 8).toString("base64");
		const freshSecret = "whsec_" + Buffer.alloc(32, 9).toString("base64");
		const original = x.f.host.storage.compareAndSet.bind(x.f.host.storage);
		let interleaved = false,
			authoritative;
		x.f.host.storage.compareAndSet = async (key, revision, value) => {
			if (
				key === "dot/external/v1" &&
				!interleaved &&
				value.current?.binding?.subscription?.secret === lateSecret
			) {
				interleaved = true;
				const removed = await x.request("events/unsubscribe", {
					name: "dot.summoned",
					arguments: {
						attempt_id: formal.attemptId,
						pairing_code: formal.pairingCode,
					},
					delivery: { mode: "webhook", url: formal.subscription.url },
				});
				assert.equal(removed.body.error, undefined);
				if (reauthorize) {
					const message = await x.active.actions["dot.show-instructions"](
						{},
						undefined,
						x.f.owner,
					);
					const code = message.data.match(/pairing_code=([a-f0-9]+)/)[1];
					const renewed = await x.request("events/subscribe", {
						name: "dot.summoned",
						arguments: { attempt_id: formal.attemptId, pairing_code: code },
						delivery: {
							mode: "webhook",
							url: formal.subscription.url,
							secret: freshSecret,
						},
						ttlMs: null,
					});
					assert.equal(renewed.body.error, undefined);
				}
				authoritative = structuredClone(x.f.records.get(key));
			}
			return original(key, revision, value);
		};
		const late = await x.request("events/subscribe", {
			name: "dot.summoned",
			arguments: {
				attempt_id: formal.attemptId,
				pairing_code: formal.pairingCode,
			},
			delivery: {
				mode: "webhook",
				url: formal.subscription.url,
				secret: lateSecret,
			},
			ttlMs: null,
		});
		assert.ok(late.body.error);
		assert.equal(interleaved, true);
		assert.deepEqual(x.f.records.get("dot/external/v1"), authoritative);
	});

test("explicit owner migration accepts the saved legacy route template but never revives its signed credential", async (t) => {
	const x = await setup(t);
	await completePairing(x);
	x.f.host.capability.inspectExternal = async (input) => {
		assert.equal(input.token, "old-signed-token");
		return { usable: true, reason: "usable", refreshRecommended: false };
	};
	const state = x.f.records.get("dot/external/v1").value;
	const {pluginInstanceId: _localInstallation, ...signedFields} = state.current;
	await x.f.host.storage.set("dot/external/v1", {
		...state,
		current: {
			...signedFields,
			kind: "signed",
			token: "old-signed-token",
			tokenId: "old-signed-jti",
			expiresAt: Math.floor(Date.now() / 1000) + 86400,
			refreshRecommendedAt: Math.floor(Date.now() / 1000) + 3600,
		},
		endpoint: {
			mode: "long-lived",
			serverUrl:
				"https://dot.example/api/plugin-runtime/handle?token=old-signed-token",
			reachableAt: 1,
		},
	});
	const migrated = await x.active.actions["dot.refresh-credential"](
		{
			input: {
				longLivedServerUrlTemplate:
					"https://dot.example/api/plugin-runtime/handle?token={token}",
			},
		},
		undefined,
		x.f.owner,
	);
	const url = new URL(migrated.data),
		next = url.searchParams.get("token");
	assert.equal(url.pathname, path);
	assert.equal(
		x.f.records.get("dot/external/v1").value.current.tokenId,
		"old-signed-jti",
	);
	await completePairing({
		...x,
		request: (method, params, provided = next) =>
			x.request(method, params, provided),
	});
	assert.equal(x.f.records.get("dot/external/v1").value.current.kind, "plugin");
	const old = await x.active.handle({
		method: "POST",
		headers: {},
		credential: {
			sub: x.f.host.pluginInstanceId,
			cap: "dot-mcp",
			jti: "old-signed-jti",
			iat: 1,
			exp: 2_000_000_000,
		},
		body: { jsonrpc: "2.0", id: 1, method: "server/discover", params: {} },
	});
	assert.ok(old.body.error);
});

for (const cancel of [false,true]) test(`temporary candidate reuses the saved formal generation after a long-lived candidate (cancel=${cancel})`, async t => {
  const original = {start:TemporaryEndpointController.prototype.start,allowToken:TemporaryEndpointController.prototype.allowToken,stop:TemporaryEndpointController.prototype.stop};
  let lease, starts = 0, connection;
  const allowed = new Set();
  TemporaryEndpointController.prototype.start = async function(input) {
    if (lease) await connection.expireTemporary(lease.generation);
    allowed.clear(); allowed.add(input.token); starts++;
    lease = {generation:`fixture-${starts}`,serverUrl:`https://temp.example/mcp?token=${input.token}`,startedAt:Date.now(),expiresAt:Date.now()+input.ttlMs};
    return lease;
  };
  TemporaryEndpointController.prototype.allowToken = function(token) {
    assert.ok(lease); allowed.add(token);
    return {...lease,serverUrl:`https://temp.example/mcp?token=${token}`};
  };
  TemporaryEndpointController.prototype.stop = async function() { lease = undefined; };
  t.after(() => Object.assign(TemporaryEndpointController.prototype,original));
  const x = await setup(t);
  connection = new DotConnection(x.f.host,x.f.sendWebhook,new AbortController().signal);
  await x.active.actions['dot.cancel-pending']({},undefined,x.f.owner);
  const first = await x.active.actions['dot.start-temporary']({input:{temporaryEndpointHours:1}},undefined,x.f.owner);
  const token = new URL(first.data).searchParams.get('token');
  await completePairing({...x,request:(method,params)=>x.request(method,params,token)});
  const formal = structuredClone(x.f.records.get('dot/external/v1').value.current);
  const saved = structuredClone(x.f.records.get('dot/external/v1').value.endpoint);
  await x.active.actions['dot.use-long-lived']({input:{longLivedServerUrlTemplate:`https://dot.example${path}?token={token}`}},undefined,x.f.owner);
  assert.equal(x.f.records.get('dot/external/v1').value.endpoint.mode,'long-lived');
  assert.deepEqual(x.f.records.get('dot/external/v1').value.pending.previousEndpoint,saved);
  const next = await x.active.actions['dot.start-temporary']({input:{temporaryEndpointHours:1}},undefined,x.f.owner);
  assert.equal(starts,1,'an unverified candidate must not stop the saved formal tunnel');
  assert.ok(allowed.has(token)); assert.ok(allowed.has(new URL(next.data).searchParams.get('token')));
  const external = x.f.records.get('dot/external/v1').value;
  assert.equal(external.endpoint.generation,saved.generation);
  assert.equal(external.endpoint.expiresAt,saved.expiresAt);
  assert.deepEqual(external.pending.previousEndpoint,saved);
  assert.deepEqual(external.current,formal);
  assert.equal((await connection.ready()).bindingAuthority.tokenId,formal.tokenId);
  if (cancel) {
    await x.active.actions['dot.cancel-pending']({},undefined,x.f.owner);
    assert.deepEqual(x.f.records.get('dot/external/v1').value.endpoint,saved);
    assert.equal((await connection.ready()).bindingAuthority.tokenId,formal.tokenId);
  } else {
    const candidateToken = new URL(next.data).searchParams.get('token');
    await completePairing({...x,request:(method,params)=>x.request(method,params,candidateToken)});
    assert.notEqual(x.f.records.get('dot/external/v1').value.current.tokenId,formal.tokenId);
    assert.equal(x.f.records.get('dot/external/v1').value.endpoint.generation,saved.generation);
    assert.equal(starts,1);
  }
});

for (const window of ['before-commit','after-commit']) test(`late cancel cannot revoke or stop a replacement candidate (${window})`, async t => {
  const original={start:TemporaryEndpointController.prototype.start,allowToken:TemporaryEndpointController.prototype.allowToken,stop:TemporaryEndpointController.prototype.stop};
  let activeLease,sequence=0,connection;
  TemporaryEndpointController.prototype.start=async function(input){
    const previous=activeLease;
    if(previous) await connection.expireTemporary(previous.generation);
    activeLease={generation:`cancel-race-${++sequence}`,serverUrl:`https://temp.example/mcp?token=${input.token}`,startedAt:Date.now(),expiresAt:Date.now()+input.ttlMs};
    return activeLease;
  };
  TemporaryEndpointController.prototype.allowToken=function(token){assert.ok(activeLease);return {...activeLease,serverUrl:`https://temp.example/mcp?token=${token}`};};
  TemporaryEndpointController.prototype.stop=async function(reason,expected){
    if(!activeLease || (expected!==undefined && expected!==activeLease.generation))return;
    const stopped=activeLease;activeLease=undefined;
    await connection.expireTemporary(stopped.generation);
  };
  t.after(()=>Object.assign(TemporaryEndpointController.prototype,original));
  const x=await setup(t);
  connection=new DotConnection(x.f.host,x.f.sendWebhook,new AbortController().signal);
  await x.active.actions['dot.cancel-pending']({},undefined,x.f.owner);
  await x.active.actions['dot.start-temporary']({input:{temporaryEndpointHours:1}},undefined,x.f.owner);
  let entered,release,paused=false;
  const reached=new Promise(r=>entered=r),gate=new Promise(r=>release=r),cas=x.f.host.storage.compareAndSet.bind(x.f.host.storage);
  x.f.host.storage.compareAndSet=async(key,revision,value)=>{
    if(!paused && key==='dot/external/v1' && value.pending===null){
      paused=true;
      if(window==='before-commit'){entered();await gate;return cas(key,revision,value);}
      const result=await cas(key,revision,value);entered();await gate;return result;
    }
    return cas(key,revision,value);
  };
  const cancelling=x.active.actions['dot.cancel-pending']({},undefined,x.f.owner);
  await reached;
  const next=window==='before-commit'
    ? await x.active.actions['dot.refresh-credential']({},undefined,x.f.owner)
    : await x.active.actions['dot.start-temporary']({input:{temporaryEndpointHours:1}},undefined,x.f.owner);
  const protectedState=structuredClone(x.f.records.get('dot/external/v1'));
  const generation=activeLease.generation;
  release();
  if(window==='before-commit')await assert.rejects(cancelling,/dot_candidate_stale/);
  else await cancelling;
  assert.equal(activeLease?.generation,generation);
  assert.deepEqual(x.f.records.get('dot/external/v1'),protectedState);
  assert.equal(await connection.serverUrl(),next.data);
});
