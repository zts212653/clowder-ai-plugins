import assert from "node:assert/strict";
import test from "node:test";
import { createDotPlugin } from "../src/plugin-entrypoint.ts";
import { CONNECTION_KEY, EXTERNAL_KEY } from "../src/store.ts";
import { fixture } from "./fixture.mjs";
const secret = "whsec_" + Buffer.alloc(32, 9).toString("base64");
async function until(read) {
	for (let i = 0; i < 200; i++) {
		const value = await read();
		if (value) return value;
		await new Promise((r) => setTimeout(r, 5));
	}
	assert.fail("automatic verification never started");
}
async function setup(t, delay = 5) {
	const f = fixture(t, {
		config: {
			longLivedServerUrlTemplate:
				"https://dot.example/api/plugins/official.chatgpt-dot/mcp?token={token}",
		},
	});
	let module;
	let active;
	const start = async () => {
		module = createDotPlugin({
			sendWebhook: async (url, headers, body, signal, beforeWrite) => {
				await beforeWrite?.();
				const normal = await f.sendWebhook(url, headers, body, signal);
				return f.webhookHook?.(JSON.parse(body), normal) ?? normal;
			},
			verificationDelayMs: delay,
		});
		active = await module.start(f.host);
	};
	await start();
	t.after(() => active.stop({ reason: "test" }));
	const endpoint = await active.actions["dot.use-long-lived"](
		{
			input: {
				longLivedServerUrlTemplate:
					"https://dot.example/api/plugins/official.chatgpt-dot/mcp?token={token}",
			},
		},
		undefined,
		f.owner,
	);
	let token = new URL(endpoint.data).searchParams.get("token");
	const request = (method, params) =>
		active.webhook.handle({
			contributionId: "dot-mcp-ingress",
			request: {
				method: "POST",
				path: "mcp",
				headers: {},
				query: { token },
				body: { jsonrpc: "2.0", id: 1, method, params },
			},
		});
	async function subscribe(url = "https://callbacks.example/auto") {
		await request("server/discover", {});
		const instructions = await active.actions["dot.show-instructions"](
			{},
			undefined,
			f.owner,
		);
		const code = instructions.data.match(/pairing_code=([a-f0-9]+)/)[1];
		return request("events/subscribe", {
			name: "dot.summoned",
			arguments: {
				attempt_id: f.records.get(CONNECTION_KEY).value.attemptId,
				pairing_code: code,
			},
			delivery: { mode: "webhook", url, secret },
			ttlMs: null,
		});
	}
	async function event() {
		return until(
			() => f.records.get(EXTERNAL_KEY).value.pending?.verificationEventId,
		);
	}
	async function finish(id) {
		assert.equal(
			(
				await request("tools/call", {
					name: "cat_cafe_dot_read_source",
					arguments: { event_id: id },
				})
			).body.error,
			undefined,
		);
		const nonce = f.records.get(`dot/dispatch/${id}`).value.expectedNonce;
		assert.equal(
			(
				await request("tools/call", {
					name: "cat_cafe_dot_reply",
					arguments: { event_id: id, content: `ok ${nonce}` },
				})
			).body.error,
			undefined,
		);
	}
	return {
		f,
		request,
		subscribe,
		event,
		finish,
		get active() {
			return active;
		},
		async restart() {
			await active.stop({ reason: "test" });
			await start();
		},
		async rotate() {
			const result = await active.actions["dot.refresh-credential"](
				{
					input: {
						longLivedServerUrlTemplate:
							"https://dot.example/api/plugins/official.chatgpt-dot/mcp?token={token}",
					},
				},
				undefined,
				f.owner,
			);
			token = new URL(result.data).searchParams.get("token");
		},
	};
}
test("subscription alone verifies, recurring subscribe and restart reuse its evidence", async (t) => {
	const x = await setup(t);
	assert.equal((await x.subscribe()).body.error, undefined);
	const id = await x.event();
	await x.finish(id);
	assert.equal(x.f.records.get(EXTERNAL_KEY).value.pending, null);
	const count = x.f.sent.length;
	assert.equal((await x.subscribe()).body.error, undefined);
	await x.restart();
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(
		x.f.sent.length,
		count,
		"restart/renewal must not create new test messages",
	);
	const status = await x.active.actions["dot.status"]({}, undefined, x.f.owner);
	assert.equal(status.data.rows[0].key, "ready");
	assert.deepEqual(
		status.data.rows[0].actions.map((a) => a.action),
		["refresh-credential", "disconnect"],
	);
});
for (const expired of [false, true])
	test(`candidate verification is automatic and preserves the current binding until nonce reply (expired=${expired})`, async (t) => {
		const x = await setup(t);
		await x.subscribe();
		await x.finish(await x.event());
		const old = structuredClone(x.f.records.get(EXTERNAL_KEY).value.current);
		if (expired) {
			const state = x.f.records.get(EXTERNAL_KEY).value;
			await x.f.host.storage.set(EXTERNAL_KEY, {
				...state,
				current: {
					...state.current,
					binding: {
						...state.current.binding,
						subscription: {
							...state.current.binding.subscription,
							expiresAt: Date.now() - 1,
						},
					},
				},
			});
		}
		await x.rotate();
		await x.subscribe("https://callbacks.example/new");
		const id = await x.event();
		assert.equal(
			x.f.records.get(EXTERNAL_KEY).value.current.tokenId,
			old.tokenId,
		);
		assert.equal(
			x.f.webhooks.filter((w) => w.data.eventId === id).at(-1).url,
			"https://callbacks.example/new",
		);
		await x.finish(id);
		assert.notEqual(
			x.f.records.get(EXTERNAL_KEY).value.current.tokenId,
			old.tokenId,
		);
	});

function jobOf(x) {
	return [...x.f.records.entries()].find(([key]) =>
		key.startsWith("dot/verification/"),
	)?.[1].value;
}
test("automatic failures and explicit retry reuse the same nonce, source and event", async (t) => {
	const x = await setup(t);
	x.f.webhookHook = (body, normal) =>
		body.name === "dot.summoned" ? { status: 503, body: "{}" } : normal;
	await x.subscribe();
	await until(() => jobOf(x)?.stage === "failed");
	const before = jobOf(x);
	assert.ok(before.eventId);
	const count = x.f.sent.length;
	x.f.webhookHook = undefined;
	await x.active.actions["dot.retry-verification"]({}, undefined, x.f.owner);
	await until(
		() =>
			x.f.records.get(`dot/dispatch/${before.eventId}`).value
				.webhookAcknowledgedAt !== null,
	);
	assert.equal(x.f.sent.length, count);
	assert.equal(jobOf(x).nonce, before.nonce);
	assert.equal(jobOf(x).eventId, before.eventId);
	await x.finish(before.eventId);
});
test("stopping before scheduled work then restarting creates one verification source", async (t) => {
	const x = await setup(t, 50);
	await x.subscribe();
	await x.restart();
	const id = await x.event();
	assert.equal(x.f.sent.length, 1);
	await x.finish(id);
	await x.restart();
	await new Promise((r) => setTimeout(r, 70));
	assert.equal(x.f.sent.length, 2, "only the source and its real reply exist");
});
test("canceling a candidate before background work sends no verification", async (t) => {
	const x = await setup(t, 30);
	await x.subscribe();
	await x.active.actions["dot.cancel-pending"]({}, undefined, x.f.owner);
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(x.f.sent.length, 0);
});
test("unknown thread-creation outcome requires an explicit retry and does not loop across restart", async (t) => {
	const x = await setup(t);
	const create = x.f.host.threads.create;
	let creates = 0;
	x.f.host.threads.create = async (input) => {
		creates++;
		await create(input);
		throw Error("lost creation response");
	};
	await x.subscribe();
	await until(() => jobOf(x)?.stage === "failed");
	assert.equal(jobOf(x).error, "dot_verification_creation_unknown");
	assert.equal(creates, 1);
	await x.restart();
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(creates, 1);
	x.f.host.threads.create = async (input) => {
		creates++;
		return create(input);
	};
	await x.active.actions["dot.retry-verification"]({}, undefined, x.f.owner);
	const id = await x.event();
	assert.equal(creates, 2);
	await x.finish(id);
});

test("stopping while automatic thread creation is admitted drains the write and never emits a stale verification", async (t) => {
	const x = await setup(t);
	let enter, release;
	const entered = new Promise((r) => {
			enter = r;
		}),
		gate = new Promise((r) => {
			release = r;
		});
	const create = x.f.host.threads.create;
	x.f.host.threads.create = async (input) => {
		enter();
		await gate;
		return create(input);
	};
	await x.subscribe();
	await entered;
	let stopped = false;
	const stopping = x.active.stop({ reason: "test" }).then(() => {
		stopped = true;
	});
	await new Promise((r) => setImmediate(r));
	assert.equal(stopped, false);
	release();
	await stopping;
	assert.equal(x.f.sent.length, 0);
});

test("a new subscription scheduled during an active verification is not lost", async (t) => {
	const { AutomaticDotVerification } = await import(
		"../src/automatic-verification.ts"
	);
	const controller = new AbortController();
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const verifier = new AutomaticDotVerification(
		{
			connection: {
				signal: controller.signal,
				within: (_context, run) => run(),
			},
			host: {},
		},
		5,
	);
	let runs = 0;
	verifier.run = async () => {
		if (++runs === 1) await gate;
	};
	t.after(async () => {
		release();
		verifier.stop();
		await verifier.settle();
	});
	verifier.schedule(0);
	await until(() => runs === 1);
	verifier.schedule(0);
	await new Promise((resolve) => setTimeout(resolve, 15));
	assert.equal(runs, 1, "only one verification may execute at a time");
	release();
	await until(() => runs === 2);
});

async function saveReplyBeforeInterruptedPromotion(x) {
	const id = await x.event();
	await until(() =>
		[...x.f.records.entries()].some(
			([k, v]) =>
				k.startsWith("dot/verification/") &&
				v.value.eventId === id &&
				v.value.stage === "sent",
		),
	);
	const cas = x.f.host.storage.compareAndSet.bind(x.f.host.storage);
	let fail = true;
	x.f.host.storage.compareAndSet = async (key, revision, value) => {
		if (
			fail &&
			key === EXTERNAL_KEY &&
			value.pending?.verificationReplyAt != null
		) {
			fail = false;
			throw new Error("interrupted proof commit");
		}
		return cas(key, revision, value);
	};
	await assert.rejects(x.finish(id));
	const record = x.f.records.get(`dot/dispatch/${id}`).value;
	assert.ok(record.replyMessageId);
	x.f.host.storage.compareAndSet = cas;
	return record;
}

for (const replacement of [false, true])
	for (const recovery of ["restart", "retry"])
		test(`saved nonce proof finishes ${replacement ? "replacement" : "first pairing"} via ${recovery}`, async (t) => {
			const x = await setup(t);
			await x.subscribe();
			if (replacement) {
				await x.finish(await x.event());
				await x.rotate();
				await x.subscribe("https://callbacks.example/replacement");
			}
			const record = await saveReplyBeforeInterruptedPromotion(x);
			const count = x.f.sent.length;
			if (recovery === "restart") await x.restart();
			else
				await x.active.actions["dot.retry-verification"](
					{},
					undefined,
					x.f.owner,
				);
			await until(() => x.f.records.get(EXTERNAL_KEY).value.pending === null);
			assert.equal(
				x.f.records.get(EXTERNAL_KEY).value.current.verifiedEventId,
				record.eventId,
			);
			assert.equal(
				x.f.sent.length,
				count,
				"local recovery must not send another source or reply",
			);
		});

for (const change of ["cancel", "replace", "disconnect"])
	test(`proof recovery cannot promote after ${change} during persisted reply read`, async (t) => {
		const x = await setup(t);
		await x.subscribe();
		await x.finish(await x.event());
		const formal = structuredClone(x.f.records.get(EXTERNAL_KEY).value.current);
		await x.rotate();
		await x.subscribe("https://callbacks.example/replacement");
		const record = await saveReplyBeforeInterruptedPromotion(x);
		let changed = false;
		const get = x.f.host.messaging.get;
		x.f.host.messaging.get = async (id) => {
			const message = await get(id);
			if (id === record.replyMessageId && !changed) {
				changed = true;
				if (change === "replace") await x.rotate();
				else
					await x.active.actions[
						change === "cancel" ? "dot.cancel-pending" : "dot.disconnect"
					]({}, undefined, x.f.owner);
			}
			return message;
		};
		await x.active.actions["dot.retry-verification"]({}, undefined, x.f.owner);
		await until(() => changed);
		await new Promise((resolve) => setTimeout(resolve, 25));
		const state = x.f.records.get(EXTERNAL_KEY).value;
		assert.deepEqual(state.current, change === "disconnect" ? null : formal);
		if (change === "replace") {
			assert.notEqual(
				state.pending.candidateId,
				record.candidateProof.candidateId,
			);
			assert.equal(state.pending.verificationReplyAt, null);
		} else assert.equal(state.pending, null);
	});

for (const replacement of [false, true])
	test(`delivered verification timeout offers a stable retry (replacement=${replacement})`, async (t) => {
		const x = await setup(t);
		if (!replacement) {
			const external = x.f.records.get(EXTERNAL_KEY).value;
			await x.f.host.storage.set(EXTERNAL_KEY, { ...external, current: null });
		}
		await x.subscribe();
		if (replacement) {
			await x.finish(await x.event());
			await x.rotate();
			await x.subscribe("https://callbacks.example/replacement");
		}
		const id = await x.event();
		await until(() =>
			[...x.f.records.entries()].some(
				([k, v]) =>
					k.startsWith("dot/verification/") &&
					v.value.eventId === id &&
					v.value.stage === "sent",
			),
		);
		const key = `dot/dispatch/${id}`,
			before = structuredClone(x.f.records.get(key).value);
		await x.f.host.storage.set(key, {
			...before,
			occurredAt: Date.now() - 120_000,
		});
		const status = await x.active.actions["dot.status"](
			{},
			undefined,
			x.f.owner,
		);
		const actions = status.data.rows[0].actions.map((a) => a.action);
		assert.ok(actions.includes("retry-verification"));
		assert.ok(actions.includes(replacement ? "cancel-pending" : "disconnect"));
		const count = x.f.sent.length;
		await x.active.actions["dot.retry-verification"]({}, undefined, x.f.owner);
		await until(() =>
			[...x.f.records.entries()].some(
				([k, v]) =>
					k.startsWith("dot/verification/") &&
					v.value.eventId === id &&
					v.value.attempts > 0 &&
					v.value.stage === "sent",
			),
		);
		const after = x.f.records.get(key).value;
		assert.equal(after.sourceMessageId, before.sourceMessageId);
		assert.equal(after.expectedNonce, before.expectedNonce);
		assert.equal(x.f.sent.length, count);
		await x.finish(id);
		assert.equal(x.f.records.get(EXTERNAL_KEY).value.pending, null);
	});

test("local proof recovery rejects a stored reply whose content no longer matches the nonce proof", async (t) => {
	const x = await setup(t);
	await x.subscribe();
	const record = await saveReplyBeforeInterruptedPromotion(x);
	const saved = x.f.messages.get(record.replyMessageId);
	x.f.messages.set(record.replyMessageId, {
		...saved,
		content: "unrelated content",
	});
	await x.active.actions["dot.retry-verification"]({}, undefined, x.f.owner);
	await until(() =>
		[...x.f.records.entries()].some(
			([k, v]) =>
				k.startsWith("dot/verification/") &&
				v.value.eventId === record.eventId &&
				v.value.stage === "failed",
		),
	);
	assert.ok(x.f.records.get(EXTERNAL_KEY).value.pending);
	assert.equal(
		x.f.records.get(EXTERNAL_KEY).value.pending.verificationReplyAt,
		null,
	);
});
