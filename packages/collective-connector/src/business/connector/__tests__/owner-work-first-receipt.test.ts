import { expect, test } from "vitest";
import type { PluginOwnerHttpContext, PluginStorageHost, PluginTaskReadItem } from "@clowder-ai/plugin-sdk";
import { collectiveEventSourceIdentity } from "../../contracts/index.js";
import { createCollectiveOwnerWorkCaller as sourceOwnerCaller } from "../../../owner-work-manual-caller.js";
import { fixture } from "./communication-work-custody.fixture.js";

const requestId = "54f70c6f-faf8-4a0b-8f9d-2e409bfcbb19";
const createCollectiveOwnerWorkCaller: typeof sourceOwnerCaller = process.env.OWNER_WORK_CALLER_COMPILED === "1"
  ? (await import(new URL("../../../../dist/owner-work-manual-caller.js", import.meta.url).href)).createCollectiveOwnerWorkCaller
  : sourceOwnerCaller;

/** Real human Service commitment; storage, Task and authenticated request ports
 * below are explicit fixtures. The actual Host composition is verified separately. */
async function setup(intendedOutcome?: string) {
  const f = await fixture();
  const proposed = await f.store.proposeCollectiveWork(f.owner.sessionToken, {
    serviceInstanceId: f.connection.serviceInstanceId, collectiveId: f.connection.collectiveId,
    sourceEventId: f.source.eventId, requestId: "first-manual-proposal",
    ...(intendedOutcome ? {intendedOutcome} : {}),
  });
  const work = await f.store.commitCollectiveWork(f.owner.sessionToken, {
    serviceInstanceId: f.connection.serviceInstanceId, collectiveId: f.connection.collectiveId,
    workId: proposed.workId, expectedRevision: proposed.revision, requestId: "first-manual-commit",
    assignment: { connectionId: f.connection.connectionId, catId: "codex-sol", participationRevision: 1 },
  });
  await f.connector.sync(f.connection.connectionId);
  const item = (await f.connector.listInbox(f.connection.connectionId)).find(row => row.event.eventId === work.assignmentEventId)!;
  const identity = collectiveEventSourceIdentity(item.event)!;
  await f.connector.beginInboxRouting(f.connection.connectionId, item.event.eventId, 1);
  await f.connector.completeInboxRouting(f.connection.connectionId, item.event.eventId, 1, {
    kind: "thread_message", threadId: "channel", messageId: "source", catId: identity.catId,
  });
  let sourceAvailable = true;
  const source = { id: "source", userId: "local-owner", threadId: "channel", catId: null,
    content: item.event.body, mentions: [], timestamp: 1, sourceRevision: "source-revision-1",
    source: { connector: "collective", label: "Collective", icon: "message", meta: {
      participation: identity, workRequest: "entrust", workAcceptanceNotice: item.event.workAcceptanceNotice,
    } } };
  let revision = 0, active = true, prepareCalls = 0, dispatchCalls = 0;
  const records = new Map<string, {revision: number; value: unknown}>();
  const storage: PluginStorageHost = {
    async get(key) { return structuredClone(records.get(key)); },
    async list() { return structuredClone(Object.fromEntries(records)); },
    async set() { throw new Error("Unconditional receipt overwrite is forbidden"); },
    async delete() { throw new Error("Receipt deletion is forbidden"); },
    async compareAndSet(key, expected, value) {
      if ((records.get(key)?.revision ?? null) !== expected) return {applied: false};
      records.set(key, {revision: ++revision, value: structuredClone(value)});
      return {applied: true, revision};
    },
  };
  const current = async () => { if (!active) throw new Error("owner request expired"); };
  const owner: PluginOwnerHttpContext = {kind: "owner-http-request", userId: "local-owner", pluginInstanceId: "instance",
    operation: "write", signal: new AbortController().signal, assertCurrent: current,
    requestIdentity: {kind: "owner_http", requestId: "host-generated-id", transportRequestId: "diagnostic-only",
      pluginId: "official.collective-connector", pluginInstanceId: "instance", userId: "local-owner",
      contributionId: "manual-work", method: "POST", declaredPath: "connections/:connectionId/work/admit",
      path: `connections/${f.connection.connectionId}/work/admit`, bodyDigest: "a".repeat(64), queryDigest: "b".repeat(64)},
  };
  let task: PluginTaskReadItem | null = null;
  const result = {result: "admitted" as const, taskRef: "task:work:task", taskRevision: 1, threadId: "child",
    admissionRef: "message:protected-admission", executionRef: "message:protected-execution"};
  const ports = {pluginInstanceId: "instance", connector: f.connector, storage,
    messaging: {get: async () => sourceAvailable ? structuredClone(source) : null},
    threads: {get: async (id: string) => ({id, title: "Work", deepLinkUrl: "https://fixture/thread/"+id,
      createdAt: 1, lastActiveAt: 1, preferredCats: [], featureRefs: []}),
      ensureByKey: async () => ({id: "child", title: "Work", deepLinkUrl: "https://fixture/thread/child",
        createdAt: 1, lastActiveAt: 1, preferredCats: [], featureRefs: []})},
    tasks: {get: async () => structuredClone(task), listByKind: async () => task ? [structuredClone(task)] : [],
      async prepareEntrusted() {
        prepareCalls++;
        // Selection must already be durable before the first Host effect.
        expect(records.size).toBe(1);
        task = {id: "task", kind: "work", title: work.title, userId: "local-owner", ownerCatId: identity.catId, subjectKey: null,
          threadId: "child", status: "todo", createdAt: 1, updatedAt: 1, createdBy: "user", why: "Review",
          entrustedWork: {revision: 1, admission: {sourceRefs: ["message:source"]}, closure: {state: "open"}}};
        return result;
      },
      async dispatchEntrusted() {
        dispatchCalls++;
        const row = [...records.values()][0]!.value as {binding?: unknown};
        expect(row.binding).toEqual(expect.objectContaining({admissionRef: result.admissionRef, executionRef: result.executionRef}));
        return {messageRef: "message:queued", entryId: "entry", status: "queued" as const};
      }},
  };
  const make = () => createCollectiveOwnerWorkCaller({current, ports});
  return {...f, ownerContext: owner, ports, records, source, make,
    calls: () => ({prepareCalls, dispatchCalls}), expire: () => {active = false;},
    recall: () => {sourceAvailable = false;},
    input: {sourceMessageId: "source", requestId}};
}

test("manual human Work binds a real owner first choice before prepare and exact Host execution before dispatch", async () => {
  const f = await setup();
  try {
    const result = await f.make().admit("local-owner", f.connection.connectionId, f.input, f.ownerContext);
    if (result.result === "needs_clarification") throw new Error("Unexpected clarification");
    expect(result.queue.status).toBe("queued");
    const record = [...f.records.values()][0]!.value as {basis: {kind: string}; firstRequest: {requestId: string}};
    expect(record.basis.kind).toBe("manual_owner_write");
    expect(record.firstRequest.requestId).toBe("host-generated-id");
    expect(f.calls()).toEqual({prepareCalls: 1, dispatchCalls: 1});
  } finally {await f.close();}
});

test("reopen and a later HTTP request reuse immutable first receipt without changing request provenance", async () => {
  const f = await setup();
  try {
    await f.make().admit("local-owner", f.connection.connectionId, f.input, f.ownerContext);
    const before = structuredClone([...f.records.values()][0]);
    await f.make().admit("local-owner", f.connection.connectionId, {...f.input, requestId: "e2ecbb52-969e-4b98-a24d-eb54c55b01ef"},
      {...f.ownerContext, requestIdentity: {...f.ownerContext.requestIdentity!, requestId: "later-authenticated-http"}});
    expect([...f.records.values()][0]).toEqual(before);
  } finally {await f.close();}
});

test("unauthenticated, wrong-owner, read-only, missing Host identity and expired requests cannot select a first receipt", async () => {
  const f = await setup();
  try {
    for (const caller of [undefined, {...f.ownerContext, userId: "foreign"}, {...f.ownerContext, operation: "read" as const},
      {...f.ownerContext, requestIdentity: undefined}]) {
      await expect(f.make().admit("local-owner", f.connection.connectionId, f.input, caller)).rejects.toMatchObject({code: "OWNER_ADMISSION_UNAVAILABLE"});
    }
    f.expire();
    await expect(f.make().admit("local-owner", f.connection.connectionId, f.input, f.ownerContext)).rejects.toThrow("owner request expired");
    expect(f.records.size).toBe(0);expect(f.calls()).toEqual({prepareCalls: 0, dispatchCalls: 0});
  } finally {await f.close();}
});

test("recalled source and conflicting retained first choice refuse before another private effect", async () => {
  const f = await setup();
  try {
    await f.make().admit("local-owner", f.connection.connectionId, f.input, f.ownerContext);
    const entry = [...f.records.values()][0]!;
    (entry.value as {basis: {kind: string}}).basis.kind = "standing_grant";
    await expect(f.make().admit("local-owner", f.connection.connectionId, f.input, f.ownerContext)).rejects.toMatchObject({code: "OWNER_ADMISSION_CONFLICT"});
    f.recall();
    await expect(f.make().admit("local-owner", f.connection.connectionId, f.input, f.ownerContext)).rejects.toMatchObject({code: "OWNER_ADMISSION_UNAVAILABLE"});
    expect(f.calls()).toEqual({prepareCalls: 1, dispatchCalls: 1});
  } finally {await f.close();}
});

test("a lost first-receipt CAS response recovers its original choice without preparing a Task twice", async () => {
  const f = await setup();
  try {
    const write = f.ports.storage.compareAndSet.bind(f.ports.storage);
    let lose = true;
    f.ports.storage.compareAndSet = async (...args) => {
      const result = await write(...args);
      if (lose) {lose = false; throw new Error("receipt response lost after durable write");}
      return result;
    };
    await expect(f.make().admit("local-owner", f.connection.connectionId, f.input, f.ownerContext)).rejects.toThrow("receipt response lost");
    expect(f.records.size).toBe(1);expect(f.calls()).toEqual({prepareCalls: 0, dispatchCalls: 0});
    await f.make().admit("local-owner", f.connection.connectionId, f.input,
      {...f.ownerContext, requestIdentity: {...f.ownerContext.requestIdentity!, requestId: "retry-after-loss"}});
    const receipt = [...f.records.values()][0]!.value as {firstRequest: {requestId: string}};
    expect(receipt.firstRequest.requestId).toBe("host-generated-id");
    expect(f.calls()).toEqual({prepareCalls: 1, dispatchCalls: 1});
  } finally {await f.close();}
});

test("real Service revocation after Host prepare rejects dispatch and keeps the incomplete receipt honest", async () => {
  const f = await setup();
  try {
    const prepare = f.ports.tasks.prepareEntrusted;
    f.ports.tasks.prepareEntrusted = async () => {
      const result = await prepare();
      await f.store.revokeConnection({sessionToken: f.owner.sessionToken,
        collectiveId: f.connection.collectiveId, connectionId: f.connection.connectionId});
      return result;
    };
    await expect(f.make().admit("local-owner", f.connection.connectionId, f.input, f.ownerContext)).rejects.toBeDefined();
    expect(f.calls()).toEqual({prepareCalls: 1, dispatchCalls: 0});
    expect((([...f.records.values()][0]!.value) as {binding?: unknown}).binding).toBeUndefined();
  } finally {await f.close();}
});

test("deadline clarification retains the first choice and completes it only after the owner supplies time", async () => {
  const f = await setup("Finish the implementation by tomorrow.");
  try {
    const clarify = await f.make().admit("local-owner", f.connection.connectionId, f.input, f.ownerContext);
    expect(clarify.result).toBe("needs_clarification");
    expect(f.calls()).toEqual({prepareCalls: 0, dispatchCalls: 0});
    const first = structuredClone([...f.records.values()][0]!.value) as {binding?: unknown; firstRequest: unknown};
    expect(first.binding).toBeUndefined();
    const result = await f.make().admit("local-owner", f.connection.connectionId,
      {...f.input, businessDeadline: Date.now() + 86_400_000},
      {...f.ownerContext, requestIdentity: {...f.ownerContext.requestIdentity!, requestId: "clarified-http-request"}});
    expect(result.result).toBe("admitted");
    expect((([...f.records.values()][0]!.value) as {firstRequest: unknown}).firstRequest).toEqual(first.firstRequest);
    expect(f.calls()).toEqual({prepareCalls: 1, dispatchCalls: 1});
  } finally {await f.close();}
});

test("another authenticated plugin instance cannot fork a retained first source/Cat choice during clarification", async () => {
  const f = await setup("Finish the implementation by tomorrow.");
  try {
    expect((await f.make().admit("local-owner", f.connection.connectionId, f.input, f.ownerContext)).result)
      .toBe("needs_clarification");
    const before = structuredClone([...f.records]);
    const instance = "another-current-instance";
    const caller = createCollectiveOwnerWorkCaller({current: async () => {},
      ports: {...f.ports, pluginInstanceId: instance}});
    await expect(caller.admit("local-owner", f.connection.connectionId, f.input,
      {...f.ownerContext, pluginInstanceId: instance, requestIdentity: {...f.ownerContext.requestIdentity!,
        pluginInstanceId: instance, requestId: "another-authenticated-http"}}))
      .rejects.toMatchObject({code: "OWNER_ADMISSION_CONFLICT"});
    expect([...f.records]).toEqual(before);
    expect(f.calls()).toEqual({prepareCalls: 0, dispatchCalls: 0});
  } finally {await f.close();}
});

test("bound admission replay uses the captured execution after evidence advances the Task aggregate", async () => {
  const f = await setup();
  try {
    const first = await f.make().admit("local-owner", f.connection.connectionId, f.input, f.ownerContext);
    if (first.result === "needs_clarification") throw new Error("Unexpected clarification");
    const before = structuredClone([...f.records]);
    const originalRead = f.ports.tasks.get;
    f.ports.tasks.get = async () => {
      const task = await originalRead();
      return task?.entrustedWork ? {...task, entrustedWork: {...task.entrustedWork, revision: 2}} : task;
    };
    // A real Host rejects the second prepare's immutable receipt conflict.
    // Here refusal isolates the caller's unwanted prepare; real Host proof is separate.
    f.ports.tasks.prepareEntrusted = async () => {throw new Error("Bound execution must not prepare again");};
    const replay = await f.make().admit("local-owner", f.connection.connectionId, f.input,
      {...f.ownerContext, requestIdentity: {...f.ownerContext.requestIdentity!, requestId: "replay-after-evidence"}});
    if (replay.result === "needs_clarification") throw new Error("Unexpected clarification");
    expect(replay.taskRevision).toBe(first.taskRevision);
    expect(replay.executionRef).toBe(first.executionRef);
    expect(replay.queue.entryId).toBe(first.queue.entryId);
    expect([...f.records]).toEqual(before);
    expect(f.calls()).toEqual({prepareCalls: 1, dispatchCalls: 2});
  } finally {await f.close();}
});
