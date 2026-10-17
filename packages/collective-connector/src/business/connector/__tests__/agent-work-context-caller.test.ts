import { expect, test } from "vitest";
import type { PluginActionContext, PluginNativeTaskContext, PluginTaskReadItem } from "@clowder-ai/plugin-sdk";
import { collectiveEventSourceIdentity } from "../../contracts/index.js";
import { fixture } from "./communication-work-custody.fixture.js";
import { opaqueHostAdmission } from "../../../collective-work-admission-caller.js";
import { createCollectiveAgentWorkContextCaller as sourceContextCaller } from "../../../agent-work-context-caller.js";
import { publishCollectiveProgress as sourceProgress } from "../../../owner-work-progress.js";

const createCollectiveAgentWorkContextCaller: typeof sourceContextCaller =
  process.env.OWNER_WORK_CALLER_COMPILED === "1"
    ? (await import(new URL("../../../../dist/agent-work-context-caller.js", import.meta.url).href))
        .createCollectiveAgentWorkContextCaller
    : sourceContextCaller;

const publishCollectiveProgress: typeof sourceProgress =
  process.env.OWNER_WORK_CALLER_COMPILED === "1"
    ? (await import(new URL("../../../../dist/owner-work-progress.js", import.meta.url).href)).publishCollectiveProgress
    : sourceProgress;

/** Actual Service/Connector acknowledgement, explicit synthetic authenticated Task context/read ports. */
async function setup() {
  const f = await fixture();
  await f.connector.adoptWorkPolicy(f.connection.connectionId, "local-owner", f.policy.revision);
  const work = await f.connector.acceptWork(f.source, f.agent, f.input);
  await f.connector.sync(f.connection.connectionId);
  const item = (await f.connector.listInbox(f.connection.connectionId)).find(
    (row) => row.event.eventId === work.assignmentEventId,
  );
  if (!item) throw new Error("Expected actual assignment");
  const identity = collectiveEventSourceIdentity(item.event);
  if (!identity) throw new Error("Expected exact assignment source");
  await f.connector.beginInboxRouting(f.connection.connectionId, item.event.eventId, 1);
  await f.connector.completeInboxRouting(f.connection.connectionId, item.event.eventId, 1, {
    kind: "thread_message",
    threadId: "channel",
    messageId: "host-source",
    catId: identity.catId,
  });
  await f.connector.withAssignedWorkAuthority(f.connection.connectionId, work.workId, async (scope) => {
    const authority = scope.work.acceptance;
    if (!authority || !scope.work.assignmentEventId) throw new Error("Expected actual acceptance");
    await scope.recordHostAdmission({
      workId: work.workId,
      assignmentEventId: scope.work.assignmentEventId,
      operationRef: authority.operationRef,
      grantRef: authority.grantRef,
      grantRevision: authority.grantRevision,
      executionRevision: 1,
      disposition: {
        state: "admitted",
        receiptRef: opaqueHostAdmission({ userId: "local-owner", id: "host-source" }, work.workId, "host-task"),
      },
    });
  });
  let native: PluginNativeTaskContext = {
    userId: "local-owner",
    catId: identity.catId,
    threadId: "private",
    invocationId: "fixture-running-turn",
    originTriggerMessageId: "host-trigger",
    source: {
      id: "host-source",
      threadId: "channel",
      userId: "local-owner",
      catId: null,
      content: item.event.body,
      source: {
        connector: "collective",
        meta: {
          participation: identity,
          workRequest: item.event.workRequest,
          workAcceptanceNotice: item.event.workAcceptanceNotice,
        },
      },
      extra: { pluginMessage: { instanceId: "fixture-instance" } },
    },
    task: {
      taskRef: "task:work:host-task",
      taskRevision: 1,
      admissionRef: "message:protected-first",
      executionRef: "message:protected-execution",
      sourceRevision: 1,
    },
  };
  let task: PluginTaskReadItem = {
    id: "host-task",
    userId: "local-owner",
    threadId: "private",
    kind: "work",
    title: "A",
    why: work.intendedOutcome,
    subjectKey: null,
    ownerCatId: identity.catId,
    status: "todo",
    createdBy: "system",
    createdAt: 1,
    updatedAt: 1,
    entrustedWork: { revision: 1, closure: { state: "open" }, admission: { sourceRefs: ["message:host-source"] } },
  };
  let active = true;
  const action: PluginActionContext = {
    catId: identity.catId,
    userId: "local-owner",
    threadId: "private",
    invocationId: "fixture-running-turn",
    originTriggerMessageId: "host-trigger",
    ownerAuthProvenance: "unknown",
    toolExecutionPolicy: { mode: "plugin_native", pluginInstanceId: "fixture-instance" },
    assertCurrent: async () => {
      if (!active) throw new Error("Task invocation expired");
    },
  };
  const caller = createCollectiveAgentWorkContextCaller({
    connector: f.connector,
    context: {
      nativeContext: {
        async current(input?: { readonly includeTask: true }) {
          expect(input).toEqual({ includeTask: true });
          return native;
        },
      },
      tasks: {
        async get(id) {
          return id === task.id ? task : null;
        },
      },
    },
  });
  return {
    ...f,
    work,
    identity,
    action,
    caller,
    native: () => native,
    task: () => task,
    setNative: (value: PluginNativeTaskContext) => {
      native = value;
    },
    setTask: (value: PluginTaskReadItem) => {
      task = value;
    },
    expire: () => {
      active = false;
    },
  };
}

test("authenticated Agent Task binds the original source, current Service admission and immutable result/execution round", async () => {
  const f = await setup();
  try {
    await f.caller.withCurrentTask(f.action, async (binding) => {
      expect(binding.sourceRef).toBe("message:host-source");
      expect(binding.auth.originTriggerMessageId).toBe("host-trigger");
      expect(binding.auth.threadId).toBe("private");
      expect(binding.auth.source.threadId).toBe("channel");
      expect(binding.displayName).toBe("Sol");
      expect(binding.work).toMatchObject({ revision: 1, resultRevision: 1, executionRevision: 1 });
      expect(binding.refScope).toBe(
        "message:host-source:work:host-task:1:result:1:execution:1:message:protected-execution",
      );
      await binding.revalidate();
    });
  } finally {
    await f.close();
  }
});

test("foreign action, source body and canonical Task ownership are refused before consuming private context", async () => {
  const f = await setup();
  let consumed = 0;
  try {
    await expect(
      f.caller.withCurrentTask({ ...f.action, catId: "foreign" }, async () => {
        consumed++;
      }),
    ).rejects.toMatchObject({ code: "WORK_EXECUTION_NOT_CURRENT" });
    const original = f.native();
    f.setNative({ ...original, source: { ...original.source, content: "Changed external message" } });
    await expect(
      f.caller.withCurrentTask(f.action, async () => {
        consumed++;
      }),
    ).rejects.toMatchObject({ code: "WORK_EXECUTION_NOT_CURRENT" });
    f.setNative(original);
    const task = f.task();
    if (!task.entrustedWork) throw new Error("Expected fixture Task");
    f.setTask({ ...task, ownerCatId: "foreign" });
    await expect(
      f.caller.withCurrentTask(f.action, async () => {
        consumed++;
      }),
    ).rejects.toMatchObject({ code: "WORK_EXECUTION_NOT_CURRENT" });
    expect(consumed).toBe(0);
  } finally {
    await f.close();
  }
});

test("Task source cannot change the actual request kind or add an unissued Service execution notice", async () => {
  const f = await setup();
  let consumed = 0;
  try {
    const original = f.native();
    for (const patch of [
      { workRequest: "continue" },
      { workExecutionNotice: { workId: f.work.workId, revision: 77 } },
    ]) {
      f.setNative({
        ...original,
        source: {
          ...original.source,
          source: { ...original.source.source, meta: { ...original.source.source.meta, ...patch } },
        },
      });
      await expect(
        f.caller.withCurrentTask(f.action, async () => {
          consumed++;
        }),
      ).rejects.toMatchObject({ code: "WORK_EXECUTION_NOT_CURRENT" });
    }
    expect(consumed).toBe(0);
  } finally {
    await f.close();
  }
});

test("remote grant revocation after binding refuses the same private action rather than borrowing owner identity", async () => {
  const f = await setup();
  try {
    await expect(
      f.caller.withCurrentTask(f.action, async (binding) => {
        const policy = await f.store.registerCollectiveWorkPolicy(f.owner.sessionToken, {
          serviceInstanceId: f.connection.serviceInstanceId,
          collectiveId: f.connection.collectiveId,
          connectionId: f.connection.connectionId,
          expectedRevision: f.policy.revision,
          grants: [],
          requestId: "revoke-task-context",
        });
        expect(policy.grants).toMatchObject([{ status: "revoked", grantRevision: 2 }]);
        await expect(binding.revalidate()).rejects.toMatchObject({ code: "WORK_DELEGATION_UNAVAILABLE" });
      }),
    ).rejects.toMatchObject({ code: "WORK_DELEGATION_UNAVAILABLE" });
  } finally {
    await f.close();
  }
});

test("private callback refuses a changed execution receipt or closed canonical Task after its initial read", async () => {
  const f = await setup();
  try {
    await expect(
      f.caller.withCurrentTask(f.action, async (binding) => {
        const native = f.native();
        f.setNative({ ...native, task: { ...native.task, executionRef: "message:other-execution" } });
        await expect(binding.revalidate()).rejects.toMatchObject({ code: "WORK_EXECUTION_NOT_CURRENT" });
      }),
    ).rejects.toMatchObject({ code: "WORK_EXECUTION_NOT_CURRENT" });
  } finally {
    await f.close();
  }
  const g = await setup();
  try {
    await expect(
      g.caller.withCurrentTask(g.action, async (binding) => {
        g.setTask({ ...g.task(), status: "done" });
        await expect(binding.revalidate()).rejects.toMatchObject({ code: "WORK_EXECUTION_NOT_CURRENT" });
      }),
    ).rejects.toMatchObject({ code: "WORK_EXECUTION_NOT_CURRENT" });
  } finally {
    await g.close();
  }
});

test("binding currentness cannot escape its original consumer lifetime", async () => {
  const f = await setup();
  try {
    const binding = await f.caller.withCurrentTask(f.action, async (binding) => binding);
    await expect(binding.revalidate()).rejects.toThrow("consumer scope has ended");
    f.expire();
    await expect(f.caller.withCurrentTask(f.action, async () => {})).rejects.toThrow("Task invocation expired");
  } finally {
    await f.close();
  }
});

test("the first execution cannot acquire a newer result round by rereading current Service numbers", async () => {
  const f = await setup();
  let consumed = 0;
  try {
    const assignmentEventId = f.work.assignmentEventId;
    if (!assignmentEventId) throw new Error("Expected original assignment");
    const execution = { revision: 1, assignmentEventId };
    const operation = await f.connector.prepareReply(
      f.identity,
      "message:host-source",
      "work:host-task",
      1,
      1,
      execution,
    );
    // Explicit Service-only snapshot fixture; no file/seal/Host Artifact publication is claimed.
    await f.connector.submitReply(
      f.identity,
      "message:host-source",
      "work:host-task",
      operation.outboxId,
      "Reviewable fixture result",
      f.agent,
      {
        taskRef: "task:work:host-task",
        taskRevision: 1,
        artifactRef: "artifact:fixture",
        artifactRevision: "1",
        completenessRef: "artifact:fixture#complete:1",
        previewRef: "artifact:fixture#preview:1",
        openInWorkspaceRef: "workspace:artifact:fixture:1:artifact:fixture",
      },
      1,
      execution,
    );
    await f.connector.sync(f.connection.connectionId);
    const result = await f.connector.prepareReply(f.identity, "message:host-source", "work:host-task", 1, 1, execution);
    expect(result.status).toBe("accepted");
    const ready = await f.connector.readAssignedWork(f.connection.connectionId, f.work.workId);
    expect(ready.lifecycle).toBe("result_ready");
    await f.caller.withCurrentTask(f.action, async (binding) => {
      expect(binding.work.resultRevision).toBe(1);
    });
    const revised = await f.store.requestCollectiveWorkRevision(f.owner.sessionToken, {
      serviceInstanceId: f.connection.serviceInstanceId,
      collectiveId: f.connection.collectiveId,
      workId: f.work.workId,
      expectedRevision: ready.revision,
      requestId: "revision-after-task-context",
      resultEventId: result.acceptedEventId,
      resultRevision: 1,
      feedback: "Add the recovery evidence.",
    });
    expect(revised.lifecycle).toBe("in_progress");
    await expect(
      f.caller.withCurrentTask(f.action, async () => {
        consumed++;
      }),
    ).rejects.toMatchObject({ code: "WORK_EXECUTION_NOT_CURRENT" });
    expect(consumed).toBe(0);
  } finally {
    await f.close();
  }
});

test("original private progress can acquire its own sync fence without reentering a held connection mutex", async () => {
  const f = await setup();
  let progress: Promise<unknown> | undefined;
  try {
    const receipt = await f.caller.withCurrentTask(f.action, async (binding) => {
      await binding.revalidate();
      progress = publishCollectiveProgress(
        f.connector,
        binding.auth,
        binding,
        "Verified progress from the private Task.",
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          progress,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error("Private progress reentered its connection mutex")), 1500);
          }),
        ]);
        await binding.revalidate();
        return result;
      } finally {
        clearTimeout(timeout);
      }
    });
    expect(receipt).toMatchObject({
      status: "accepted",
      receipt: { workId: f.work.workId, resultRevision: 1, executionRevision: 1 },
    });
    expect((await f.connector.readAssignedWork(f.connection.connectionId, f.work.workId)).lifecycle).not.toBe(
      "completed",
    );
  } finally {
    // A failing lock probe is released by the failed consumer; drain its actual
    // fixture operation before removing the isolated Service/Connector stores.
    await progress?.catch(() => {});
    await f.close();
  }
});

// The actual Registry/Task metadata and revocation contrast is independently
// exercised by the compiled Host+SDK composition probe; this port-level test
// isolates the package's consumer/refScope behavior.
test("evidence-only aggregate changes keep the authenticated execution scope stable", async () => {
  const f = await setup();
  try {
    await f.caller.withCurrentTask(f.action, async binding => {
      const before = binding.refScope;
      const task = f.task();
      if (!task.entrustedWork) throw new Error("Expected Task");
      f.setTask({ ...task, entrustedWork: { ...task.entrustedWork, revision: 2 } });
      await binding.revalidate();
      expect(binding.refScope).toBe(before);
      expect(binding.work.revision).toBe(f.native().task.taskRevision);
    });
  } finally { await f.close(); }
});
