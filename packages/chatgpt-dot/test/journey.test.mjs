import assert from "node:assert/strict";
import test from "node:test";
import { delivery, paired, rpc } from "./fixture.mjs";

test("pair, addressed receive, read and source-bound reply survive restart without a global subscription", async (t) => {
	const f = await paired(t);
	assert.equal(typeof f.active.deliver, "function");
	assert.equal(typeof f.active.handle, "function");
	assert.equal(f.active.call, undefined);
	assert.equal(f.active.delivery, undefined);
	assert.equal(f.credentials.credentialSecret, undefined);
	assert.equal(
		JSON.stringify(f.credentials).includes(f.host.external.token),
		false,
	);
	assert.deepEqual(await f.active.deliver(delivery(f)), {
		deliveryId: "delivery-1",
	});
	const event = f.webhooks.find((x) => x.data.name === "dot.summoned").data;
	assert.equal(event.data.source_message_id, "source-1");
	assert.ok(
		(
			await rpc(f, "cat_cafe_dot_reply", {
				event_id: event.eventId,
				content: "too early",
			})
		).error,
	);
	assert.equal(
		(await rpc(f, "cat_cafe_dot_read_source", { event_id: event.eventId }))
			.result.structuredContent.source.id,
		"source-1",
	);
	const first = await rpc(f, "cat_cafe_dot_reply", {
		event_id: event.eventId,
		content: "answer",
	});
	assert.equal(first.result.structuredContent.messageId, "reply-0");
	assert.equal(f.sent[0].input.replyTo, "source-1");
	assert.equal(f.sent[0].input.identity, "dot");
	await f.active.stop({ reason: "disabled" });
	await assert.rejects(() => f.active.deliver(delivery(f)), /stopped|revoked/);
	f.active = await f.module.start(f.host);
	await f.active.deliver(delivery(f));
	assert.equal(
		f.webhooks.filter((x) => x.data.name === "dot.summoned").length,
		1,
	);
	await rpc(f, "cat_cafe_dot_reply", {
		event_id: event.eventId,
		content: "answer",
	});
	assert.equal(f.sent.length, 1);
});

test("forged callback targets, changed source and stale pairing cannot grant a reply", async (t) => {
	const f = await paired(t);
	await f.active.deliver(delivery(f));
	const event = f.webhooks.at(-1).data;
	assert.ok(
		(
			await rpc(f, "cat_cafe_dot_reply", {
				event_id: event.eventId,
				content: "forged",
				thread_id: "other",
			})
		).error,
	);
	f.messages.set("source-1", { ...f.source, sourceRevision: "edited" });
	assert.ok(
		(await rpc(f, "cat_cafe_dot_read_source", { event_id: event.eventId }))
			.error,
	);
	await f.settings.actions["dot.reconnect"]({}, undefined, f.owner);
	assert.ok(
		(await rpc(f, "cat_cafe_dot_read_source", { event_id: event.eventId }))
			.error,
	);
	assert.equal(f.sent.length, 0);
});

test("owner operations reject caller-supplied identity without Host owner context", async (t) => {
	const f = await paired(t);
	await assert.rejects(
		() => f.settings.actions["dot.disconnect"]({ userId: "owner" }),
		/owner/,
	);
	await assert.rejects(
		() =>
			f.settings.actions["dot.begin-pairing"]({}, undefined, {
				...f.owner,
				userId: "intruder",
			}),
		/owner/,
	);
});

test("connection test distinguishes webhook receipt from source read and nonce-bound model reply", async (t) => {
	const f = await paired(t);
	assert.equal(
		(await f.active.actions["dot.test"]({}, undefined, f.owner)).ok,
		false,
	);
	const started = await f.active.actions["dot.roundtrip"](
		{},
		undefined,
		f.owner,
	);
	assert.equal(started.render, "rows");
	const connection = (await f.host.storage.get("dot/connection/v1")).value,
		eventId = connection.testEventIds.at(-1),
		dispatch = (await f.host.storage.get(`dot/dispatch/${eventId}`)).value;
	assert.equal(
		(await f.active.actions["dot.test"]({}, undefined, f.owner)).ok,
		false,
	);
	await rpc(f, "cat_cafe_dot_read_source", { event_id: eventId });
	assert.ok(
		(
			await rpc(f, "cat_cafe_dot_reply", {
				event_id: eventId,
				content: "missing nonce",
			})
		).error,
	);
	await rpc(f, "cat_cafe_dot_reply", {
		event_id: eventId,
		content: `confirmed ${dispatch.expectedNonce}`,
	});
	assert.equal(
		(await f.active.actions["dot.test"]({}, undefined, f.owner)).ok,
		true,
	);
});

test("an established active subscription keeps its instructions after the initial pairing deadline", async (t) => {
	const f = await paired(t);
	const state = f.records.get("dot/connection/v1").value;
	assert.notEqual(state.pairedAt, null);
	state.pairingExpiresAt = Date.now() - 1;

	const result = await f.settings.actions["dot.show-instructions"](
		{},
		undefined,
		f.owner,
	);
	assert.equal(result.render, "text");
	assert.match(result.data, /pairing_code=/);
});

test("generic connection test keeps old evidence but cannot report a revoked attempt as currently ready", async (t) => {
	const f = await paired(t);
	const state = f.records.get("dot/connection/v1").value;
	const eventId = `dot_evt_${"a".repeat(64)}`;
	state.testEventIds = [eventId];
	state.revokedAt = Date.now();
	f.records.set(`dot/dispatch/${eventId}`, {
		revision: 1,
		value: {
			eventId,
			ownerUserId: "owner",
			threadId: "thread-1",
			sourceMessageId: "source-1",
			dispatchInvocationId: "test:nonce",
			attemptId: state.attemptId,
			agentKeyId: state.agentKeyId,
			occurredAt: Date.now(),
			webhookAcknowledgedAt: Date.now(),
			sourceReadAt: Date.now(),
			replyMessageId: "reply-1",
			imagePublicationIds: [],
			connectionTest: true,
			expectedNonce: "a".repeat(16),
		},
	});

	const result = await f.active.actions["dot.test"]({}, undefined, f.owner);
	assert.equal(result.ok, false);
	assert.equal(result.details.revoked, true);
});

test("a fast subscribed reply is retried until its ask receipt is durably mapped", async (t) => {
	const f = await paired(t);
	f.host.messaging.subscribe = async () => {};
	const args = {
		attempt_id: f.credentials.attemptId,
		thread_id: "thread-1",
		target_cat_ids: ["cat-1"],
		content: "question",
		client_message_id: "first",
	};
	await rpc(f, "cat_cafe_dot_ask", args);
	const entered = Promise.withResolvers(),
		release = Promise.withResolvers();
	const set = f.host.storage.set.bind(f.host.storage);
	f.host.storage.set = async (key, value) => {
		if (
			key.startsWith("dot/ask/") &&
			value.messageId &&
			value.messageId !== "reply-0"
		) {
			entered.resolve(value.messageId);
			await release.promise;
		}
		return set(key, value);
	};
	const ask = rpc(f, "cat_cafe_dot_ask", {
		...args,
		client_message_id: "second",
	});
	const parent = await entered.promise;
	const source = {
		...f.source,
		id: "fast-reply",
		catId: "cat-1",
		replyTo: parent,
	};
	f.messages.set(source.id, source);
	const input = {
		...delivery(f, "fast-delivery"),
		reason: "subscription",
		envelope: { ...delivery(f).envelope, messageId: source.id },
	};
	try {
		await assert.rejects(f.active.deliver(input), /dot_ask_receipt_pending/);
	} finally {
		release.resolve();
		await ask;
	}
	await f.active.deliver(input);
	await f.active.deliver(input);
	assert.equal(
		f.webhooks.filter(
			(x) =>
				x.data.name === "dot.summoned" &&
				x.data.data.source_message_id === source.id,
		).length,
		1,
	);
});
test("proactive questions subscribe only to their thread and forward only exact recipient replies", async (t) => {
	const f = await paired(t),
		subscriptions = [];
	f.host.messaging.subscribe = async (input) => subscriptions.push(input);
	const args = {
		attempt_id: f.credentials.attemptId,
		thread_id: "thread-1",
		target_cat_ids: ["cat-1"],
		content: "A question",
		client_message_id: "q-1",
	};
	const question = (await rpc(f, "cat_cafe_dot_ask", args)).result
		.structuredContent;
	assert.equal(question.messageId, "reply-0");
	assert.equal(subscriptions.length, 1);
	assert.equal(subscriptions[0].threadId, "thread-1");
	const reply = {
		...f.source,
		id: "cat-reply",
		catId: "cat-1",
		replyTo: question.messageId,
		content: "answer",
		sourceRevision: "cat-answer",
	};
	f.messages.set(reply.id, reply);
	const input = {
		...delivery(f, "answer-delivery"),
		reason: "subscription",
		envelope: { ...delivery(f).envelope, messageId: reply.id },
	};
	await f.active.deliver(input);
	assert.equal(f.webhooks.at(-1).data.data.source_message_id, reply.id);
	const count = f.webhooks.length;
	f.messages.set(reply.id, { ...reply, replyTo: "unrelated" });
	await f.active.deliver({ ...input, deliveryId: "unrelated" });
	assert.equal(f.webhooks.length, count);
	assert.ok(
		(
			await rpc(f, "cat_cafe_dot_ask", {
				...args,
				content: "@other\nroute elsewhere",
				client_message_id: "q-2",
			})
		).error,
	);
	await f.active.stop({ reason: "disabled" });
	f.active = await f.module.start(f.host);
	assert.equal(subscriptions.at(-1).threadId, "thread-1");
	assert.equal(new Set(subscriptions.map((s) => s.threadId)).size, 1);
});

test("stable delivery identity deduplicates retries even when execution diagnostics change", async (t) => {
	const f = await paired(t),
		input = delivery(f);
	await f.active.deliver({
		...input,
		executionId: "execution-before-restart",
	});
	await f.active.deliver({
		...input,
		executionId: "execution-after-restart",
	});
	assert.equal(
		f.webhooks.filter((item) => item.data.name === "dot.summoned").length,
		1,
	);
});

test("a source-bound reply never treats cloud text as a new recipient selector", async (t) => {
	const f = await paired(t);
	await f.active.deliver(delivery(f));
	const eventId = f.webhooks.at(-1).data.eventId;
	await rpc(f, "cat_cafe_dot_read_source", { event_id: eventId });
	await rpc(f, "cat_cafe_dot_reply", {
		event_id: eventId,
		content: "@Dot\nanswer",
	});
	assert.equal(f.sent[0].input.wake, undefined);
});

test("a reply to a member wakes only the member proven by the original source", async (t) => {
	const f = await paired(t);
	f.messages.set(f.source.id, { ...f.source, catId: "cat-1" });
	await f.active.deliver(delivery(f));
	const eventId = f.webhooks.at(-1).data.eventId;
	await rpc(f, "cat_cafe_dot_read_source", { event_id: eventId });
	await rpc(f, "cat_cafe_dot_reply", {
		event_id: eventId,
		content: "@other\nanswer",
	});
	assert.deepEqual(f.sent[0].input.wake, { catId: "cat-1" });
});
