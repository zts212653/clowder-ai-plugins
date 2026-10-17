import { expect, test } from "vitest";
import type { PluginTaskReadItem, PluginTaskHost, PluginTaskAdmissionInput } from "@clowder-ai/plugin-sdk";
import { collectiveEventSourceIdentity } from "../../contracts/index.js";
import { fixture } from "./communication-work-custody.fixture.js";
import { createCollectiveWorkAdmissionCaller as sourceAdmissionCaller } from "../../../collective-work-admission-caller.js";

const createCollectiveWorkAdmissionCaller: typeof sourceAdmissionCaller =
  process.env.OWNER_WORK_CALLER_COMPILED === "1"
    ? (await import(new URL("../../../../dist/collective-work-admission-caller.js", import.meta.url).href))
        .createCollectiveWorkAdmissionCaller
    : sourceAdmissionCaller;

async function accepted() {
  const f = await fixture();
  await f.connector.adoptWorkPolicy(f.connection.connectionId, "local-owner", f.policy.revision);
  const work = await f.connector.acceptWork(f.source, f.agent, f.input);
  await f.connector.sync(f.connection.connectionId);
  const item = (await f.connector.listInbox(f.connection.connectionId)).find(
    (row) => row.event.eventId === work.assignmentEventId,
  )!;
  const identity = collectiveEventSourceIdentity(item.event)!;
  await f.connector.beginInboxRouting(f.connection.connectionId, item.event.eventId, 1);
  await f.connector.completeInboxRouting(f.connection.connectionId, item.event.eventId, 1, {
    kind: "thread_message",
    threadId: "channel",
    messageId: "host-source",
    catId: identity.catId,
  });
  const task: PluginTaskReadItem = {
    id: "host-task",
    userId: "local-owner",
    threadId: "private",
    kind: "work",
    subjectKey: null,
    title: work.title,
    ownerCatId: identity.catId,
    status: "todo",
    why: work.intendedOutcome,
    createdBy: "system",
    createdAt: 1,
    updatedAt: 1,
    entrustedWork: { revision: 1, closure: { state: "open" }, admission: { sourceRefs: ["message:host-source"] } },
  };
  const calls: string[] = [];
  const tasks: Pick<PluginTaskHost, "get" | "listByKind" | "prepareEntrusted" | "dispatchEntrusted"> = {
    async get(id) {
      calls.push("read-task");
      return id === task.id ? task : null;
    },
    async listByKind() {
      return [task];
    },
    async prepareEntrusted(input: PluginTaskAdmissionInput) {
      calls.push("prepare");
      expect(input.sourceMessageId).toBe("host-source");
      expect(Object.keys(input).sort()).toEqual(["destination", "sourceMessageId", "subject", "targetCatId"]);
      return {
        result: "admitted",
        taskRef: "task:work:host-task",
        taskRevision: 1,
        threadId: "private",
        admissionRef: "message:protected-first-receipt",
        executionRef: "message:protected-execution",
      };
    },
    async dispatchEntrusted(input) {
      calls.push("dispatch");
      expect(input).toEqual({
        taskRef: "task:work:host-task",
        taskRevision: 1,
        executionRef: "message:protected-execution",
      });
      const current = await f.connector.resolveAcceptedWorkGrant(identity);
      expect(current.work.acceptance?.hostAdmission?.state).toBe("admitted");
      return { messageRef: "message:host-trigger", entryId: "host-entry", status: "queued" };
    },
  };
  return { ...f, work, identity, task, tasks, calls };
}
test("a real Service rejection after entering the consumer fence prevents Host preparation", async () => {
  const f = await accepted();
  try {
    await f.connector.withAssignedWorkAuthority(f.connection.connectionId, f.work.workId, async (scope) => {
      const authority = scope.work.acceptance;
      if (!authority || !scope.work.assignmentEventId) throw new Error("Expected actual accepted assignment");
      const assignmentEventId = scope.work.assignmentEventId;
      let rejected = false;
      const caller = createCollectiveWorkAdmissionCaller({
        connector: f.connector,
        tasks: f.tasks,
        assertCurrent: async () => {
          if (rejected) return;
          rejected = true;
          await scope.recordHostAdmission({
            workId: f.work.workId,
            assignmentEventId,
            operationRef: authority.operationRef,
            grantRef: authority.grantRef,
            grantRevision: authority.grantRevision,
            executionRevision: 1,
            disposition: {
              state: "rejected",
              receiptRef: "actual-remote-refusal",
              reason: "OWNER_ADMISSION_UNAVAILABLE",
            },
          });
          expect((await scope.readCurrentWork()).acceptance?.hostAdmission?.state).toBe("rejected");
        },
      });
      await expect(
        caller.admitInScope(scope, {
          ownerUserId: "local-owner",
          identity: f.identity,
          sourceMessageId: "host-source",
          workId: f.work.workId,
          destination: { kind: "derived_from_source" },
        }),
      ).rejects.toMatchObject({ code: "OWNER_ADMISSION_UNAVAILABLE" });
      expect(f.calls).not.toContain("prepare");
      expect(f.calls).not.toContain("dispatch");
    });
  } finally {
    await f.close();
  }
});

test("same Connector scope records a real Service acknowledgement between Host prepare and dispatch", async () => {
  const f = await accepted();
  try {
    const caller = createCollectiveWorkAdmissionCaller({
      connector: f.connector,
      tasks: f.tasks,
      assertCurrent: async () => {
        f.calls.push("current");
      },
    });
    const result = await caller.admit({
      ownerUserId: "local-owner",
      sourceMessageId: "host-source",
      identity: f.identity,
      workId: f.work.workId,
      destination: { kind: "existing_thread", threadId: "private" },
    });
    expect(result).toMatchObject({ taskRef: "task:work:host-task", queue: { status: "queued" } });
    expect(f.calls.indexOf("prepare")).toBeLessThan(f.calls.indexOf("read-task"));
    expect(f.calls.at(-1)).toBe("current");
    expect(f.calls.filter((call) => call === "dispatch")).toHaveLength(1);
    const work = await f.connector.readAssignedWork(f.connection.connectionId, f.work.workId);
    expect(work.acceptance?.hostAdmission?.state).toBe("admitted");
    expect(work.lifecycle).not.toBe("completed");
  } finally {
    await f.close();
  }
});
test("current remote grant refusal after preparation does not dispatch or undo the actual Task effect", async () => {
  const f = await accepted();
  try {
    const prepare = f.tasks.prepareEntrusted!;
    f.tasks.prepareEntrusted = async (input) => {
      const result = await prepare(input);
      const revoked = await f.store.registerCollectiveWorkPolicy(f.owner.sessionToken, {
        serviceInstanceId: f.connection.serviceInstanceId,
        collectiveId: f.connection.collectiveId,
        connectionId: f.connection.connectionId,
        expectedRevision: f.policy.revision,
        grants: [],
        requestId: "revoke-after-prepare",
      });
      expect(revoked.grants).toMatchObject([{ grantRef: "owner-grant", status: "revoked", grantRevision: 2 }]);
      return result;
    };
    const caller = createCollectiveWorkAdmissionCaller({
      connector: f.connector,
      tasks: f.tasks,
      assertCurrent: async () => {},
    });
    await expect(
      caller.admit({
        ownerUserId: "local-owner",
        sourceMessageId: "host-source",
        identity: f.identity,
        workId: f.work.workId,
        destination: { kind: "derived_from_source" },
      }),
    ).rejects.toMatchObject({ code: "WORK_DELEGATION_UNAVAILABLE" });
    expect(f.calls).not.toContain("dispatch");
    expect(f.task.id).toBe("host-task");
  } finally {
    await f.close();
  }
});
test("foreign owner/source and clarification never gain dispatch authority", async () => {
  const f = await accepted();
  try {
    const caller = createCollectiveWorkAdmissionCaller({
      connector: f.connector,
      tasks: f.tasks,
      assertCurrent: async () => {},
    });
    const input = {
      ownerUserId: "local-owner",
      sourceMessageId: "host-source",
      identity: f.identity,
      workId: f.work.workId,
      destination: { kind: "derived_from_source" as const },
    };
    await expect(caller.admit({ ...input, ownerUserId: "foreign" })).rejects.toThrow();
    await expect(caller.admit({ ...input, sourceMessageId: "other-source" })).rejects.toThrow();
    expect(f.calls).not.toContain("prepare");
    f.tasks.prepareEntrusted = async () => ({
      result: "needs_clarification",
      clarificationReason: "Actual Lifecycle missing time",
    });
    expect(await caller.admit(input)).toEqual({
      result: "needs_clarification",
      clarificationReason: "Actual Lifecycle missing time",
    });
    expect(f.calls).not.toContain("dispatch");
  } finally {
    await f.close();
  }
});

for (const mutation of ["foreign-owner", "closed", "revision", "first-source"] as const)
  test(`prepared Host Task ${mutation} is refused before a Service acknowledgement or dispatch`, async () => {
    const f = await accepted();
    try {
      const original = f.tasks.prepareEntrusted!;
      f.tasks.prepareEntrusted = async (input) => {
        const result = await original(input);
        const task = f.task;
        if (!task.entrustedWork) throw new Error("Fixture must include the actual Task read projection");
        const work = task.entrustedWork;
        const invalid: PluginTaskReadItem =
          mutation === "foreign-owner"
            ? { ...task, userId: "foreign" }
            : mutation === "closed"
              ? { ...task, entrustedWork: { ...work, closure: { state: "completed" } } }
              : mutation === "revision"
                ? { ...task, entrustedWork: { ...work, revision: work.revision + 1 } }
                : { ...task, entrustedWork: { ...work, admission: { sourceRefs: ["message:foreign"] } } };
        f.tasks.get = async () => invalid;
        return result;
      };
      const caller = createCollectiveWorkAdmissionCaller({
        connector: f.connector,
        tasks: f.tasks,
        assertCurrent: async () => {},
      });
      await expect(
        caller.admit({
          ownerUserId: "local-owner",
          sourceMessageId: "host-source",
          identity: f.identity,
          workId: f.work.workId,
          destination: { kind: "derived_from_source" },
        }),
      ).rejects.toMatchObject({ code: "OWNER_ADMISSION_UNAVAILABLE" });
      expect(f.calls).not.toContain("dispatch");
      const current = await f.connector.readAssignedWork(f.connection.connectionId, f.work.workId);
      expect(current.acceptance?.hostAdmission).toBeUndefined();
    } finally {
      await f.close();
    }
  });
test("fresh Work read cannot escape the connection consumer fence", async () => {
  const f = await accepted();
  try {
    const scope = await f.connector.withAssignedWorkAuthority(
      f.connection.connectionId,
      f.work.workId,
      async (scope) => {
        expect((await scope.readCurrentWork()).workId).toBe(f.work.workId);
        return scope;
      },
    );
    await expect(scope.readCurrentWork()).rejects.toThrow("consumer scope has ended");
  } finally {
    await f.close();
  }
});

test("a resolved Service acknowledgement call without its actual admitted fact never dispatches", async () => {
  const f = await accepted();
  try {
    const caller = createCollectiveWorkAdmissionCaller({
      connector: f.connector,
      tasks: f.tasks,
      assertCurrent: async () => {},
    });
    await expect(
      f.connector.withAssignedWorkAuthority(f.connection.connectionId, f.work.workId, async (scope) =>
        caller.admitInScope(
          { ...scope, recordHostAdmission: async () => {} },
          {
            ownerUserId: "local-owner",
            identity: f.identity,
            sourceMessageId: "host-source",
            workId: f.work.workId,
            destination: { kind: "derived_from_source" },
          },
        ),
      ),
    ).rejects.toMatchObject({ code: "OWNER_ADMISSION_UNAVAILABLE" });
    expect(f.calls).toContain("prepare");
    expect(f.calls).not.toContain("dispatch");
    expect(
      (await f.connector.readAssignedWork(f.connection.connectionId, f.work.workId)).acceptance?.hostAdmission,
    ).toBeUndefined();
  } finally {
    await f.close();
  }
});

test("failed consumers also retire their fresh Work read operation", async () => {
  const f = await accepted();
  try {
    let read: (() => Promise<unknown>) | undefined;
    await expect(
      f.connector.withAssignedWorkAuthority(f.connection.connectionId, f.work.workId, async (scope) => {
        read = scope.readCurrentWork;
        throw new Error("Consumer failed after reading");
      }),
    ).rejects.toThrow("Consumer failed after reading");
    if (!read) throw new Error("Expected an actual scoped Work read");
    await expect(read()).rejects.toThrow("consumer scope has ended");
  } finally {
    await f.close();
  }
});

test("owner request cannot borrow Agent acceptance instead of durable owner request binding", async () => {
  const f = await accepted();
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
            sourceMessageId: "host-source",
            workId: f.work.workId,
            destination: { kind: "existing_thread", threadId: "private" },
          },
          "owner_request",
        ),
      ),
    ).rejects.toMatchObject({ code: "OWNER_ADMISSION_UNAVAILABLE" });
    expect(f.calls).not.toContain("prepare");
    expect(f.calls).not.toContain("dispatch");
  } finally {
    await f.close();
  }
});
