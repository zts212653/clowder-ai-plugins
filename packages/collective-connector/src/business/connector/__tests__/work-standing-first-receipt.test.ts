import { expect, test } from "vitest";
import type { PluginMessagingHost, PluginStorageHost, PluginTaskReadItem } from "@clowder-ai/plugin-sdk";
import { collectiveEventSourceIdentity } from "../../contracts/index.js";
import { collectiveSource } from "../../../collective-ingress-routing.js";
import { createCollectiveWorkAdmissionCaller as sourceCaller } from "../../../collective-work-admission-caller.js";
import { fixture } from "./communication-work-custody.fixture.js";

const createCaller: typeof sourceCaller = process.env.OWNER_WORK_CALLER_COMPILED === "1"
  ? (await import(new URL("../../../../dist/collective-work-admission-caller.js", import.meta.url).href)).createCollectiveWorkAdmissionCaller
  : sourceCaller;

/** Real Service grant/acceptance and Connector. Host storage/message/thread/Task
 * ports are explicit fixtures; the compiled Host combination is separate. */
async function setup() {
  const f = await fixture();
  await f.connector.adoptWorkPolicy(f.connection.connectionId, "local-owner", f.policy.revision);
  const work = await f.connector.acceptWork(f.source, f.agent, f.input);
  await f.connector.sync(f.connection.connectionId);
  const item = (await f.connector.listInbox(f.connection.connectionId)).find(x => x.event.eventId === work.assignmentEventId)!;
  const identity = collectiveEventSourceIdentity(item.event)!;
  await f.connector.beginInboxRouting(f.connection.connectionId, item.event.eventId, 1);
  await f.connector.completeInboxRouting(f.connection.connectionId, item.event.eventId, 1,
    {kind: "thread_message", messageId: "source", threadId: "channel", catId: identity.catId});
  const message = {id: "source", threadId: "channel", userId: "local-owner", catId: null,
    content: item.event.body, source: collectiveSource(item.event, identity),
    timestamp: 1, mentions: [], sourceRevision: "source-v1"};
  let version = 0, created = false, aggregate = 1, sourceAvailable = true;
  const records = new Map<string, {revision: number; value: unknown}>();
  const storage: Pick<PluginStorageHost, "get" | "compareAndSet"> = {
    async get(key) {return structuredClone(records.get(key));},
    async compareAndSet(key, expected, value) {
      if ((records.get(key)?.revision ?? null) !== expected) return {applied: false};
      records.set(key, {revision: ++version, value: structuredClone(value)});
      return {applied: true, revision: version};
    },
  };
  const messaging: Pick<PluginMessagingHost, "get"> = {get: async () => sourceAvailable ? structuredClone(message) : null};
  const task = (): PluginTaskReadItem => ({id: "task", kind: "work", userId: "local-owner", threadId: "child",
    ownerCatId: identity.catId, title: work.title, why: work.intendedOutcome, subjectKey: null, status: "todo",
    createdBy: "system", createdAt: 1, updatedAt: 1,
    entrustedWork: {revision: aggregate, admission: {sourceRefs: ["message:source"]}, closure: {state: "open"}}});
  const calls: string[] = [];
  const result = {result: "admitted" as const, taskRef: "task:work:task", taskRevision: 1, threadId: "child",
    admissionRef: "message:admission", executionRef: "message:execution"};
  const tasks = {get: async () => created ? task() : null, listByKind: async () => created ? [task()] : [],
    async prepareEntrusted() {
      calls.push("prepare");
      expect(records.size).toBe(1);
      const first = [...records.values()][0]!.value as {basis: {kind: string; grantRef: string}};
      expect(first.basis.kind).toBe("standing_grant");expect(first.basis.grantRef).toBe(f.input.grantRef);
      created = true;return result;
    },
    async dispatchEntrusted(input: unknown) {
      calls.push("dispatch");
      expect(input).toEqual({taskRef: result.taskRef, taskRevision: 1, executionRef: result.executionRef});
      const first = [...records.values()][0]!.value as {binding?: unknown};
      expect(first.binding).toEqual(expect.objectContaining({executionRef: result.executionRef}));
      const current = await f.connector.resolveAcceptedWorkGrant(identity);
      expect(current.work.acceptance?.hostAdmission?.state).toBe("admitted");
      return {messageRef: "message:trigger", entryId: "entry", status: "queued" as const};
    }};
  const threads = {get: async (id: string) => ({id, title: "Work", deepLinkUrl: "https://fixture/"+id,
    createdAt: 1, lastActiveAt: 1, preferredCats: [], featureRefs: []}),
    ensureByKey: async () => {calls.push("ensure");return {id: "child", title: "Work", deepLinkUrl: "https://fixture/child",
      createdAt: 1, lastActiveAt: 1, preferredCats: [], featureRefs: []};}};
  const options = {connector: f.connector, tasks, assertCurrent: async () => {}, firstReceipts: {storage, messaging}, threads};
  const selection = {ownerUserId: "local-owner", identity, sourceMessageId: message.id, workId: work.workId,
    destination: {kind: "derived_from_source" as const}};
  return {...f, work, identity, message, records, calls, options, selection, make: () => createCaller(options),
    evidence: () => {aggregate = 2;}, recall: () => {sourceAvailable = false;}, preexisting: () => {created = true;}};
}

test("registered standing first choice is durable before package ensure/prepare and exact binding before Service ack/dispatch", async () => {
  const f = await setup();
  try {
    const admitted = await f.make().admit(f.selection);
    expect(admitted).toMatchObject({executionRef: "message:execution", queue: {entryId: "entry"}});
    expect(f.calls).toEqual(["ensure", "prepare", "dispatch"]);
    const first = [...f.records.values()][0]!.value as {basis: {originalSource: unknown; operationRef: string}};
    expect(first.basis.originalSource).toEqual(f.source);
    expect(first.basis.operationRef).toBe(f.work.acceptance?.operationRef);
  } finally {await f.close();}
});

test("standing reopen and evidence replay preserve the original first choice and execution without prepare", async () => {
  const f = await setup();
  try {
    await f.make().admit(f.selection);const first = structuredClone([...f.records]);f.evidence();
    f.options.tasks.prepareEntrusted = async () => {throw new Error("Bound standing execution must not prepare again");};
    await f.make().admit(f.selection);
    expect([...f.records]).toEqual(first);expect(f.calls).toEqual(["ensure", "prepare", "dispatch", "dispatch"]);
  } finally {await f.close();}
});

test("owner entry cannot create a missing standing choice but can reuse an already bound one", async () => {
  const f = await setup();
  try {
    await f.connector.withAssignedWorkAuthority(f.connection.connectionId, f.work.workId, async scope => {
      await expect(f.make().admitInScope(scope, f.selection, "owner_request"))
        .rejects.toMatchObject({code: "OWNER_ADMISSION_UNAVAILABLE"});
    });
    expect(f.records.size).toBe(0);expect(f.calls).toEqual([]);
    await f.make().admit(f.selection);const first = structuredClone([...f.records]);f.evidence();
    await f.connector.withAssignedWorkAuthority(f.connection.connectionId, f.work.workId,
      scope => f.make().admitInScope(scope, f.selection, "owner_request"));
    expect([...f.records]).toEqual(first);expect(f.calls).toEqual(["ensure", "prepare", "dispatch", "dispatch"]);
  } finally {await f.close();}
});

test("surviving Task without first choice cannot be retroactively declared standing", async () => {
  const f = await setup();
  try {
    f.preexisting();
    await expect(f.make().admit(f.selection)).rejects.toMatchObject({code: "OWNER_ADMISSION_CONFLICT"});
    expect(f.records.size).toBe(0);expect(f.calls).toEqual([]);
  } finally {await f.close();}
});

test("a retained different first basis cannot be changed to standing on replay", async () => {
  const f = await setup();
  try {
    await f.make().admit(f.selection);
    const row = [...f.records.values()][0]!.value as Record<string, unknown>;
    row.basis = {kind: "manual_owner_write"};row.pluginInstanceId = "explicit-conflicting-fixture";
    row.firstRequest = {requestId: "other-owner-capture", contributionId: "owner-work", method: "POST", path: "work/admit",
      bodyDigest: "a".repeat(64), queryDigest: "b".repeat(64)};
    const before = structuredClone([...f.records]);
    await expect(f.make().admit(f.selection)).rejects.toMatchObject({code: "OWNER_ADMISSION_CONFLICT"});
    expect([...f.records]).toEqual(before);expect(f.calls).toEqual(["ensure", "prepare", "dispatch"]);
  } finally {await f.close();}
});

test("lost standing first-receipt write response preserves its choice before any Host effect", async () => {
  const f = await setup();
  try {
    const write = f.options.firstReceipts.storage.compareAndSet;let lose = true;
    f.options.firstReceipts.storage.compareAndSet = async (...args) => {
      const result = await write(...args);
      if (lose) {lose = false;throw new Error("standing choice response lost");}
      return result;
    };
    await expect(f.make().admit(f.selection)).rejects.toThrow("standing choice response lost");
    const first = structuredClone([...f.records.values()][0]!.value) as {basis: unknown};
    expect(f.records.size).toBe(1);expect(f.calls).toEqual([]);
    await f.make().admit(f.selection);
    expect((([...f.records.values()][0]!.value) as {basis: unknown}).basis).toEqual(first.basis);
    expect(f.calls).toEqual(["ensure", "prepare", "dispatch"]);
  } finally {await f.close();}
});

test("actual remote grant revocation after prepare and original source recall prevent standing dispatch", async () => {
  const f = await setup();
  try {
    const prepare = f.options.tasks.prepareEntrusted;
    f.options.tasks.prepareEntrusted = async () => {
      const result = await prepare();
      await f.store.registerCollectiveWorkPolicy(f.owner.sessionToken, {serviceInstanceId: f.connection.serviceInstanceId,
        collectiveId: f.connection.collectiveId, connectionId: f.connection.connectionId, expectedRevision: f.policy.revision,
        grants: [], requestId: "revoke-standing-after-prepare"});
      return result;
    };
    await expect(f.make().admit(f.selection)).rejects.toMatchObject({code: "WORK_DELEGATION_UNAVAILABLE"});
    expect(f.calls).toEqual(["ensure", "prepare"]);
    f.recall();await expect(f.make().admit(f.selection)).rejects.toBeDefined();
    expect(f.calls).toEqual(["ensure", "prepare"]);
  } finally {await f.close();}
});
