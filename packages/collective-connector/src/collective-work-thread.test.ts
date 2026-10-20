import assert from "node:assert/strict";
import test from "node:test";
import { resolveCollectiveWorkThread, selectCollectiveWorkThread } from "./collective-work-thread.js";
import type { PluginTaskReadItem } from "@clowder-ai/plugin-sdk";

const source = { id: "assignment", userId: "owner", threadId: "public", content: "原请求" };
function work(overrides: Partial<PluginTaskReadItem> = {}): PluginTaskReadItem {
  return {
    id: "work",
    userId: "owner",
    kind: "work",
    threadId: "existing",
    ownerCatId: "cat",
    title: "Report",
    why: "Report",
    status: "todo",
    subjectKey: null,
    createdBy: "system",
    createdAt: 1,
    updatedAt: 1,
    entrustedWork: { revision: 1, admission: { sourceRefs: ["message:assignment"] }, closure: { state: "open" } },
    ...overrides,
  };
}
test("original source/cat relation reuses the canonical Task execution site independently of createdBy or state", () => {
  for (const createdBy of ["user", "cat", "system"]) {
    assert.deepEqual(selectCollectiveWorkThread([work({ createdBy, status: "done" })], source, "cat"), {
      kind: "existing",
      threadId: "existing",
    });
  }
});
test("foreign owner/cat/source rows never win the original selection", () => {
  const rows = [
    work({ userId: "foreign" }),
    work({ ownerCatId: "foreign" }),
    work({ entrustedWork: { revision: 1, admission: { sourceRefs: ["message:other"] }, closure: { state: "open" } } }),
  ];
  assert.deepEqual(selectCollectiveWorkThread(rows, source, "cat"), {
    kind: "ensure",
    key: "collective-work:assignment:cat",
    input: { title: "原请求", parentThreadId: "public", participants: ["cat"] },
  });
});
test("multiple matching Works refuse instead of selecting the newest or an arbitrary thread", () => {
  assert.throws(
    () => selectCollectiveWorkThread([work(), work({ id: "second", threadId: "second-thread" })], source, "cat"),
    { code: "WORK_SOURCE_AMBIGUOUS" },
  );
});
test("the first child keeps the original UTF16 slice, parent, sole participant and deterministic key", () => {
  const long = { ...source, content: "😀".repeat(81) };
  const plan = selectCollectiveWorkThread([], long, "cat");
  assert.equal(plan.kind, "ensure");
  if (plan.kind !== "ensure") throw new Error("Expected child site");
  assert.equal(plan.input.title, long.content.slice(0, 160));
  assert.equal(plan.input.title.length, 160);
  assert.equal(plan.input.parentThreadId, source.threadId);
  assert.deepEqual(plan.input.participants, ["cat"]);
  assert.equal(plan.key, "collective-work:assignment:cat");
  assert.deepEqual(selectCollectiveWorkThread([], long, "cat"), plan);
});
test("a selection is a detached plan and performs no Thread or Task mutation", () => {
  const rows = [work()],
    before = structuredClone(rows);
  const plan = selectCollectiveWorkThread(rows, source, "cat");
  assert.deepEqual(rows, before);
  assert.notEqual(plan, rows[0]);
  const child = selectCollectiveWorkThread([], source, "cat");
  assert.ok(Object.isFrozen(child));
  if (child.kind === "ensure") assert.ok(Object.isFrozen(child.input.participants));
});

test("the resolver consumes existing owner-filtered neutral ports and never creates a second site for an existing Work", async () => {
  const calls: unknown[] = [];
  const threads = {
    async get(id: string) {
      calls.push(["get", id]);
      return {
        id,
        deepLinkUrl: "https://owner.example/thread/existing",
        title: null,
        createdAt: 1,
        lastActiveAt: 1,
        preferredCats: [],
        featureRefs: [],
      };
    },
    async create() {
      throw new Error("Existing Work must not create another child");
    },
  };
  const tasks = {
    async list({kind}: {kind?: string}) {
      calls.push(["tasks", kind]);
      return [work()];
    },
  };
  assert.equal(await resolveCollectiveWorkThread(threads, tasks, source, "cat", memoryStorage()), "existing");
  assert.deepEqual(calls, [
    ["tasks", "work"],
    ["get", "existing"],
  ]);
  await assert.rejects(resolveCollectiveWorkThread({ ...threads, get: async () => null }, tasks, source, "cat", memoryStorage()), {
    code: "OWNER_ADMISSION_UNAVAILABLE",
  });
});

test("the resolver forwards only original child intent to approved ensure and preserves ambiguity refusal before effects", async () => {
  const calls: unknown[] = [];
  const threads = {
    async get() {
      return {id:"canonical-child",title:null,deepLinkUrl:"/thread/canonical-child",createdAt:0,lastActiveAt:0,preferredCats:[],featureRefs:[]};
    },
    async create(input: unknown) {
      calls.push(input);
      return {
        id: "canonical-child",
        deepLinkUrl: "https://owner.example/thread/child",
        title: null,
        createdAt: 1,
        lastActiveAt: 1,
        preferredCats: [],
        featureRefs: [],
      };
    },
  };
  assert.equal(
    await resolveCollectiveWorkThread(threads, { list: async () => [] }, source, "cat", memoryStorage()),
    "canonical-child",
  );
  assert.deepEqual(calls, [
    {
        title: "原请求",
        parentThreadId: "public",
        participants: ["cat"],
      },
  ]);
  await assert.rejects(
    resolveCollectiveWorkThread(threads, { list: async () => [work(), work()] }, source, "cat", memoryStorage()),
    { code: "WORK_SOURCE_AMBIGUOUS" },
  );
  assert.equal(calls.length, 1);
});

function memoryStorage(): Pick<import('@clowder-ai/plugin-sdk').PluginStorageHost,'get'|'compareAndSet'> {
 let entry: {revision:number;value:unknown}|undefined;
 return {async get(){return entry;},async compareAndSet(_key,expected,value){if((entry?.revision??null)!==expected)return {applied:false};entry={revision:(entry?.revision??0)+1,value:structuredClone(value)};return {applied:true,revision:entry.revision};}};
}
