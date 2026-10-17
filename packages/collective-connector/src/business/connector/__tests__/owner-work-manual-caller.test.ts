import { expect, test } from "vitest";
import type { PluginTaskHost } from "@clowder-ai/plugin-sdk";
import { collectiveEventSourceIdentity } from "../../contracts/index.js";
import { fixture } from "./communication-work-custody.fixture.js";
import { createCollectiveOwnerWorkCaller as sourceOwnerCaller } from "../../../owner-work-manual-caller.js";
import { createCollectiveWorkAdmissionCaller as sourceAdmissionCaller } from "../../../collective-work-admission-caller.js";

const createCollectiveOwnerWorkCaller: typeof sourceOwnerCaller =
  process.env.OWNER_WORK_CALLER_COMPILED === "1"
    ? (await import(new URL("../../../../dist/owner-work-manual-caller.js", import.meta.url).href))
        .createCollectiveOwnerWorkCaller
    : sourceOwnerCaller;
const createCollectiveWorkAdmissionCaller: typeof sourceAdmissionCaller =
  process.env.OWNER_WORK_CALLER_COMPILED === "1"
    ? (await import(new URL("../../../../dist/collective-work-admission-caller.js", import.meta.url).href))
        .createCollectiveWorkAdmissionCaller
    : sourceAdmissionCaller;
const requestId = "54f70c6f-faf8-4a0b-8f9d-2e409bfcbb19";

/** Actual human-committed Service Work. No protected first-basis bridge exists. */
async function human() {
  const f = await fixture();
  const event = await f.store.postHumanMessage(f.owner.sessionToken, {
    serviceInstanceId: f.connection.serviceInstanceId,
    collectiveId: f.connection.collectiveId,
    clientEventId: "manual-source",
    location: { channelId: "general" },
    recipient: { kind: "channel" },
    body: "Implement A and return the result here.",
  });
  const proposed = await f.store.proposeCollectiveWork(f.owner.sessionToken, {
    serviceInstanceId: f.connection.serviceInstanceId,
    collectiveId: f.connection.collectiveId,
    sourceEventId: event.eventId,
    requestId: "manual-proposal",
  });
  const work = await f.store.commitCollectiveWork(f.owner.sessionToken, {
    serviceInstanceId: f.connection.serviceInstanceId,
    collectiveId: f.connection.collectiveId,
    workId: proposed.workId,
    expectedRevision: proposed.revision,
    requestId: "manual-commit",
    assignment: { connectionId: f.connection.connectionId, catId: "codex-sol", participationRevision: 1 },
  });
  await f.connector.sync(f.connection.connectionId);
  const item = (await f.connector.listInbox(f.connection.connectionId)).find(
    (row) => row.event.eventId === work.assignmentEventId,
  );
  if (!item) throw new Error("Expected actual Service assignment");
  const identity = collectiveEventSourceIdentity(item.event);
  if (!identity) throw new Error("Expected exact source identity");
  await f.connector.beginInboxRouting(f.connection.connectionId, item.event.eventId, 1);
  await f.connector.completeInboxRouting(f.connection.connectionId, item.event.eventId, 1, {
    kind: "thread_message",
    threadId: "channel",
    messageId: "source",
    catId: identity.catId,
  });
  const calls: string[] = [];
  const tasks: Pick<PluginTaskHost, "get" | "listByKind" | "prepareEntrusted" | "dispatchEntrusted"> = {
    async get() {
      calls.push("task-read");
      throw new Error("Unexpected Host Task read");
    },
    async listByKind() {
      calls.push("task-list");
      throw new Error("Unexpected Host Task list");
    },
    async prepareEntrusted() {
      calls.push("prepare");
      throw new Error("Unexpected Host preparation");
    },
    async dispatchEntrusted() {
      calls.push("dispatch");
      throw new Error("Unexpected Host dispatch");
    },
  };
  return { ...f, work, identity, calls, tasks };
}

test("manual owner admission without durable first basis refuses before private effects", async () => {
  const f = await human();
  try {
    const before = await f.connector.readAssignedWork(f.connection.connectionId, f.work.workId);
    expect(before.acceptance).toBeUndefined();
    expect(before.executionAuthority).toBeUndefined();
    const caller = createCollectiveOwnerWorkCaller({ current: async () => {} });
    for (const id of [requestId, "e2ecbb52-969e-4b98-a24d-eb54c55b01ef"]) {
      await expect(
        caller.admit("local-owner", f.connection.connectionId, {
          sourceMessageId: "source",
          requestId: id,
          threadId: "existing",
          businessDeadline: 1792100000000,
        }),
      ).rejects.toMatchObject({ code: "OWNER_ADMISSION_UNAVAILABLE" });
    }
    expect(f.calls).toEqual([]);
    expect(await f.connector.readAssignedWork(f.connection.connectionId, f.work.workId)).toEqual(before);
  } finally {
    await f.close();
  }
});

test("manual resume without request identity bridge refuses rather than reusing an execution", async () => {
  let currentCalls = 0;
  const caller = createCollectiveOwnerWorkCaller({
    current: async () => {
      currentCalls++;
    },
  });
  for (const id of [requestId, "e2ecbb52-969e-4b98-a24d-eb54c55b01ef"]) {
    await expect(
      caller.resume("local-owner", "connection", {
        taskId: "task",
        observedRevision: 1,
        requestId: id,
      }),
    ).rejects.toMatchObject({ code: "OWNER_ADMISSION_UNAVAILABLE" });
  }
  expect(currentCalls).toBe(2);
});

test("human admission cannot bypass missing first basis through a direct same-scope caller", async () => {
  const f = await human();
  try {
    const caller = createCollectiveWorkAdmissionCaller({
      connector: f.connector,
      tasks: f.tasks,
      assertCurrent: async () => {},
    });
    await expect(
      f.connector.withAssignedWorkAuthority(f.connection.connectionId, f.work.workId, (scope) =>
        caller.admitInScope(
          scope,
          {
            ownerUserId: "local-owner",
            identity: f.identity,
            sourceMessageId: "source",
            workId: f.work.workId,
            destination: { kind: "existing_thread", threadId: "existing" },
          },
          "owner_request",
        ),
      ),
    ).rejects.toMatchObject({ code: "OWNER_ADMISSION_UNAVAILABLE" });
    expect(f.calls).toEqual([]);
  } finally {
    await f.close();
  }
});

test("active standing config does not supply human first basis or permission to prepare", async () => {
  const f = await human();
  try {
    const caller = createCollectiveWorkAdmissionCaller({
      connector: f.connector,
      tasks: f.tasks,
      assertCurrent: async () => {},
    });
    const selection = {
      ownerUserId: "local-owner",
      identity: f.identity,
      sourceMessageId: "source",
      workId: f.work.workId,
      destination: { kind: "derived_from_source" as const },
    };
    await expect(caller.admit(selection)).rejects.toMatchObject({ code: "OWNER_ADMISSION_UNAVAILABLE" });
    const route = await f.connector.getHostRoute(f.connection.connectionId);
    if (!route) throw new Error("Expected actual route");
    const key = `${f.connection.authorizedHumanId}:codex-sol`;
    await f.connector.setHostRoute(
      f.connection.connectionId,
      {
        localOwnerUserId: route.localOwnerUserId,
        defaultIngressThreadId: route.defaultIngressThreadId,
        humanNotificationThreadId: route.humanNotificationThreadId,
        agentRoutes: {
          ...route.agentRoutes,
          [key]: {
            ...route.agentRoutes[key]!,
            standingWork: { channelIds: ["general"], requestingHumanIds: [f.owner.human.humanId], expiresAt: null },
          },
        },
      },
      route.revision,
    );
    await expect(caller.admit(selection)).rejects.toMatchObject({ code: "OWNER_ADMISSION_UNAVAILABLE" });
    expect(f.calls).toEqual([]);
  } finally {
    await f.close();
  }
});

test("strict original owner DTOs and expired owner lifetime remain refusals", async () => {
  const caller = createCollectiveOwnerWorkCaller({
    current: async () => {
      throw new Error("Owner binding expired");
    },
  });
  await expect(
    caller.admit("owner", "connection", {
      sourceMessageId: "source",
      requestId,
      ownerUserId: "foreign",
    }),
  ).rejects.toMatchObject({ name: "ZodError" });
  await expect(
    caller.resume("owner", "connection", {
      taskId: "task",
      observedRevision: 1,
      requestId,
      admissionBasis: "manual_owner_write",
    }),
  ).rejects.toMatchObject({ name: "ZodError" });
  await expect(caller.admit("owner", "connection", { sourceMessageId: "source", requestId })).rejects.toThrow(
    "Owner binding expired",
  );
  await expect(
    caller.resume("owner", "connection", { taskId: "task", observedRevision: 1, requestId }),
  ).rejects.toThrow("Owner binding expired");
});
