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
  const proposed = await f.store.proposeCollectiveWork(f.owner.sessionToken, {
    serviceInstanceId: f.connection.serviceInstanceId, collectiveId: f.connection.collectiveId,
    sourceEventId: f.source.eventId, requestId: "human-standing-propose"});
  const work = await f.store.commitCollectiveWork(f.owner.sessionToken, {
    serviceInstanceId: f.connection.serviceInstanceId, collectiveId: f.connection.collectiveId,
    workId: proposed.workId, expectedRevision: proposed.revision, requestId: "human-standing-commit",
    assignment: {connectionId: f.connection.connectionId, catId: "codex-sol", participationRevision: 1}});
  const route = await f.connector.getHostRoute(f.connection.connectionId);
  if (!route) throw new Error("Expected actual route");
  const key = `${f.connection.authorizedHumanId}:codex-sol`;
  const scope = {channelIds: ["general"], requestingHumanIds: [f.owner.human.humanId], expiresAt: null};
  await f.connector.setHostRoute(f.connection.connectionId, {
    localOwnerUserId: route.localOwnerUserId, defaultIngressThreadId: route.defaultIngressThreadId,
    humanNotificationThreadId: route.humanNotificationThreadId,
    agentRoutes: {...route.agentRoutes, [key]: {...route.agentRoutes[key]!, standingWork: scope}}}, route.revision);
  await f.connector.sync(f.connection.connectionId);
  const item = (await f.connector.listInbox(f.connection.connectionId)).find(x => x.event.eventId === work.assignmentEventId)!;
  const identity = collectiveEventSourceIdentity(item.event)!;
  const routeRevision = (await f.connector.getHostRoute(f.connection.connectionId))!.revision;
  await f.connector.beginInboxRouting(f.connection.connectionId, item.event.eventId, routeRevision);
  await f.connector.completeInboxRouting(f.connection.connectionId, item.event.eventId, routeRevision,
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
      expect(first.basis.kind).toBe("standing_grant");expect(first.basis.grantRef).toBe(`collective-host:${f.connection.connectionId}:codex-sol`);
      created = true;return result;
    },
    async dispatchEntrusted(input: unknown) {
      calls.push("dispatch");
      expect(input).toEqual({taskRef: result.taskRef, taskRevision: 1, executionRef: result.executionRef});
      const first = [...records.values()][0]!.value as {binding?: unknown};
      expect(first.binding).toEqual(expect.objectContaining({executionRef: result.executionRef}));
      expect(work.acceptance).toBeUndefined();expect(work.executionAuthority).toBeUndefined();
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

test("human commitment standing uses its real route scope, not an Agent Service acceptance", async () => {
  const f = await setup();
  try {
    expect(f.identity.actor.kind).toBe("human");expect(f.work.acceptance).toBeUndefined();
    const admitted = await f.make().admit(f.selection);
    expect(admitted).toMatchObject({executionRef: "message:execution", queue: {entryId: "entry"}});
    const first = [...f.records.values()][0]!.value as {basis: {producer: string; grantRevision: number}};
    const route = await f.connector.getHostRoute(f.connection.connectionId);
    expect(first.basis.producer).toBe("standing_work");
    expect(first.basis.grantRevision).toBe(route!.agentRoutes[`${f.connection.authorizedHumanId}:codex-sol`]!.standingWorkRevision);
    f.evidence();const before = structuredClone([...f.records]);
    await f.make().admit(f.selection);expect([...f.records]).toEqual(before);
    expect(f.calls).toEqual(["ensure", "prepare", "dispatch", "dispatch"]);
  } finally {await f.close();}
});

test("revoked human route scope refuses a retained first choice without switching basis", async () => {
  const f = await setup();
  try {
    await f.make().admit(f.selection);const before = structuredClone([...f.records]);
    const route = await f.connector.getHostRoute(f.connection.connectionId);
    if (!route) throw new Error("Expected route");
    const key = `${f.connection.authorizedHumanId}:codex-sol`;
    const branch = {...route.agentRoutes[key]!};delete branch.standingWork;
    await f.connector.setHostRoute(f.connection.connectionId, {
      localOwnerUserId: route.localOwnerUserId, defaultIngressThreadId: route.defaultIngressThreadId,
      humanNotificationThreadId: route.humanNotificationThreadId,
      agentRoutes: {...route.agentRoutes, [key]: branch}}, route.revision);
    await expect(f.make().admit(f.selection)).rejects.toBeDefined();
    expect([...f.records]).toEqual(before);expect(f.calls).toEqual(["ensure", "prepare", "dispatch"]);
  } finally {await f.close();}
});

for (const mismatch of ["requester", "channel", "expired"] as const) {
  test(`human standing ${mismatch} scope refuses before private capture or Host effects`, async () => {
    const f = await setup();
    try {
      const route = (await f.connector.getHostRoute(f.connection.connectionId))!;
      const key = `${f.connection.authorizedHumanId}:codex-sol`;
      const standingWork = {...route.agentRoutes[key]!.standingWork!};
      if (mismatch === "requester") standingWork.requestingHumanIds = ["different-human"];
      if (mismatch === "channel") standingWork.channelIds = ["private"];
      if (mismatch === "expired") standingWork.expiresAt = "2020-01-01T00:00:00.000Z";
      await f.connector.setHostRoute(f.connection.connectionId, {
        localOwnerUserId: route.localOwnerUserId, defaultIngressThreadId: route.defaultIngressThreadId,
        humanNotificationThreadId: route.humanNotificationThreadId,
        agentRoutes: {...route.agentRoutes, [key]: {...route.agentRoutes[key]!, standingWork}}}, route.revision);
      await expect(f.make().admit(f.selection)).rejects.toMatchObject({code: "OWNER_ADMISSION_UNAVAILABLE"});
      expect(f.records.size).toBe(0);expect(f.calls).toEqual([]);
    } finally {await f.close();}
  });
}

test("remote participation revoked after human standing prepare refuses dispatch without rewriting its choice", async () => {
  const f = await setup();
  try {
    const prepare = f.options.tasks.prepareEntrusted;
    f.options.tasks.prepareEntrusted = async () => {
      const result = await prepare();
      // The remote Service may revoke while the connection fence is held.
      // Local route writes use that same fence and cannot reenter this prepare.
      await f.store.revokeConnection({sessionToken: f.owner.sessionToken,
        collectiveId: f.connection.collectiveId, connectionId: f.connection.connectionId});
      return result;
    };
    await expect(f.make().admit(f.selection)).rejects.toBeDefined();
    expect(f.calls).toEqual(["ensure", "prepare"]);expect(f.records.size).toBe(1);
    const first = [...f.records.values()][0]!.value as {basis: {kind: string}; binding?: unknown};
    expect(first.basis.kind).toBe("standing_grant");expect(first.binding).toBeUndefined();
  } finally {await f.close();}
});
