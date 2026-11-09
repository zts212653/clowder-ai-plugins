import assert from "node:assert/strict";
import test from "node:test";
import { memoryStorage } from "../test/memory-storage.js";
import { SdkCommunityPrStore } from "./business/domains/community/CommunityWorkflowStores.js";
import { GitHubPrTitleReader, prTitleHttp } from "./pr-title-reader.js";

test("local title projection survives reader recreation and never consults credentials or GitHub", async (t) => {
	const storage = memoryStorage();
	const records = new SdkCommunityPrStore(storage);
	await records.create({
		repo: "org/repo",
		prNumber: 12,
		title: "Locally observed title",
		author: "author",
		state: "open",
		replyState: "unreplied",
		headSha: "a".repeat(40),
		draft: false,
	});
	let queries = 0;
	const options = {
		records,
		token: async () => {
			queries++;
			throw new Error("local reads must not ask for a credential");
		},
	};
	const reader = new GitHubPrTitleReader(options);
	t.after(() => reader.stop());
	const owner = {
		kind: "owner-http-request",
		operation: "read",
		userId: "owner",
		pluginInstanceId: "github",
		signal: new AbortController().signal,
		assertCurrent: async () => undefined,
	} as const;
	const response = await prTitleHttp(reader)(
		{
			request: {
				method: "GET",
				path: "github/pr-title",
				query: { ref: "org/repo#12", mode: "local" },
				principal: { kind: "owner", id: "owner" },
			},
		},
		undefined,
		owner,
	);
	assert.equal(response.body.title, "Locally observed title");
	assert.equal(queries, 0);
	const missing = await reader.readLocal("org/repo#13");
	assert.equal(missing, null);
	assert.equal(queries, 0);
	await reader.stop();
	const restored = new GitHubPrTitleReader({
		...options,
		records: new SdkCommunityPrStore(storage),
	});
	t.after(() => restored.stop());
	assert.equal(await restored.readLocal("org/repo#12"), "Locally observed title");
	assert.equal(queries, 0);
});

test("an explicit background lookup saves title in the original PR record and preserves review fields", async (t) => {
	const records = new SdkCommunityPrStore(memoryStorage());
	const original = await records.create({
		repo: "org/repo",
		prNumber: 12,
		title: "Before",
		author: "author",
		state: "open",
		replyState: "replied",
		headSha: "a".repeat(40),
		draft: false,
	});
	assert.ok(original);
	await records.update(original.id, { lastReviewedSha: "a".repeat(40) });
	const reader = new GitHubPrTitleReader({
		records,
		token: async () => undefined,
		execFileAsync: async () => ({
			stdout: JSON.stringify({
				number: 12,
				repository: "org/repo",
				title: "After",
				author: "author",
				state: "open",
				mergedAt: null,
				headSha: "b".repeat(40),
				draft: false,
			}),
		}),
	});
	t.after(() => reader.stop());
	assert.equal(await reader.read("org/repo#12"), "After");
	assert.equal(await reader.readLocal("org/repo#12"), "After");
	assert.equal(
		(await records.get(original.id))?.lastReviewedSha,
		"a".repeat(40),
	);
	assert.equal((await records.get(original.id))?.replyState, "replied");
});

test("collector observations update the same local title record without another provider request", async (t) => {
	const records = new SdkCommunityPrStore(memoryStorage());
	const reader = new GitHubPrTitleReader({
		records,
		token: async () => {
			throw new Error("no credential read");
		},
	});
	t.after(() => reader.stop());
	await reader.observe(
		{
			kind: "pr",
			repoFullName: "org/repo",
			number: 12,
			threadId: "thread",
			catId: "codex",
		},
		{
			title: "First",
			observedAt: 1000,
			providerUpdatedAt: new Date(1000).toISOString(),
			authorLogin: "author",
			headSha: "a".repeat(40),
			draft: false,
			state: "open",
			comments: [],
			reviews: [],
		},
	);
	await reader.observe(
		{
			kind: "pr",
			repoFullName: "org/repo",
			number: 12,
			threadId: "thread",
			catId: "codex",
		},
		{
			title: "Renamed",
			observedAt: 2000,
			providerUpdatedAt: new Date(2000).toISOString(),
			authorLogin: "author",
			headSha: "b".repeat(40),
			draft: false,
			state: "open",
			comments: [],
			reviews: [],
		},
	);
	assert.equal(await reader.readLocal("org/repo#12"), "Renamed");
});
