import { isDeepStrictEqual } from "node:util";
import type { FeatureContext, PluginActionContext, PluginNativeTaskContext, PluginMessagingHost, PluginStorageHost, PluginMessage } from "@clowder-ai/plugin-sdk";
import type { CollectiveConnector } from "./business/connector/connector.js";
import {
  collectiveEventSourceIdentity,
  collectiveSourceIdentitySchema,
  collectiveWorkAssignmentMatches,
  collectiveWorkExecutionMatches,
} from "./business/contracts/index.js";
import { resolveMaterializedParticipation } from "./business/connector/participation-custody.js";
import { collectiveContextError } from "./collective-context-refs.js";
import { opaqueHostAdmission } from "./collective-work-admission-caller.js";
import { resolveHumanStandingWorkBasis } from "./collective-human-standing.js";
import { readWorkLineageReceipt, readWorkStoredReceipt, isBootstrapWorkLineage, readWorkExecutionReceipt, workReceiptDigest } from "./owner-work-first-receipt.js";

interface Options {
  readonly connector: CollectiveConnector;
  readonly context: Pick<FeatureContext, "nativeContext"> & { readonly tasks: Pick<FeatureContext["tasks"], "get"> };
  readonly firstReceipts?: {
    readonly storage: Pick<PluginStorageHost, "get">;
    readonly messaging: Pick<PluginMessagingHost, "get">;
  };
}
const changed = () =>
  collectiveContextError(
    "WORK_EXECUTION_NOT_CURRENT",
    "The current private Task/source/Service execution changed",
  );

/** Package-internal Work reader, never an admission or a published action.
 * The Host authenticates the existing Task coordinates. The original Service
 * acceptance and source notice supply immutable business execution/result facts.
 * Supplied first-receipt composition requires the exact original choice and
 * binding for either actor; human sources always require it. Absence
 * keeps the previously reviewed Agent ack-only reader compatible;
 * neither Task.createdBy nor Host entry provenance supplies business authority. */
export function createCollectiveAgentWorkContextCaller(options: Options) {
  const { connector, context } = options;
  const readNative = async (action: PluginActionContext) => {
    await action.assertCurrent();
    if (!context.nativeContext) throw changed();
    const auth = await context.nativeContext.current({ includeTask: true });
    await action.assertCurrent();
    if (
      action.ownerAuthProvenance !== "unknown" ||
      action.toolExecutionPolicy?.mode !== "plugin_native" ||
      auth.userId !== action.userId ||
      auth.catId !== action.catId ||
      auth.threadId !== action.threadId ||
      auth.invocationId !== action.invocationId ||
      auth.originTriggerMessageId !== action.originTriggerMessageId ||
      auth.source.userId !== auth.userId ||
      auth.source.catId !== null ||
      auth.source.source.connector !== "collective" ||
      action.toolExecutionPolicy.pluginInstanceId !== auth.source.extra.pluginMessage.instanceId
    )
      throw changed();
    const parsed = collectiveSourceIdentitySchema.safeParse(auth.source.source.meta?.participation);
    if (!parsed.success || parsed.data.catId !== auth.catId ||
      (parsed.data.actor.kind !== "agent" && (parsed.data.actor.kind !== "human" || !options.firstReceipts))) throw changed();
    return { auth, source: parsed.data };
  };
  return Object.freeze({
    async withCurrentTask<T>(
      action: PluginActionContext,
      consume: (binding: {
        readonly auth: PluginNativeTaskContext;
        readonly source: Awaited<ReturnType<typeof readNative>>["source"];
        readonly sourceRef: `message:${string}`;
        readonly resultKey: string;
        readonly displayName: string;
        readonly refScope: string;
        readonly work: {
          readonly workId: string;
          readonly revision: number;
          readonly resultRevision: number;
          readonly executionRevision: number;
          readonly assignmentEventId: string;
        };
        revalidate(): Promise<void>;
      }) => Promise<T>,
    ): Promise<T> {
      const first = await readNative(action);
      const rows = (await connector.listInbox(first.source.connectionId)).filter(
        (row) => row.event.eventId === first.source.eventId,
      );
      const item = rows.length === 1 ? rows[0] : undefined;
      const notice =
        item?.event.workRequest === "continue" ? item.event.workExecutionNotice : item?.event.workAcceptanceNotice;
      const hostReceipt = options.firstReceipts
        ? await readWorkStoredReceipt(options.firstReceipts.storage, first.auth.userId, first.auth.source.id, first.auth.catId)
        : undefined;
      const bootstrap = hostReceipt && isBootstrapWorkLineage(hostReceipt) ? hostReceipt : undefined;
      const captured = bootstrap && options.firstReceipts
        ? await readWorkExecutionReceipt(options.firstReceipts.storage, first.auth.userId,
          bootstrap.bootstrapSourceMessageId, first.auth.catId)
        : hostReceipt && !isBootstrapWorkLineage(hostReceipt) ? hostReceipt : undefined;
      if (bootstrap && (!bootstrap.binding || !captured?.binding ||
        !("firstSourceMessageId" in captured) || captured.firstSourceMessageId !== bootstrap.source.id ||
        !isDeepStrictEqual(bootstrap.binding, captured.binding))) throw changed();
      await action.assertCurrent();
      const businessSource = bootstrap ? captured!.source.identity : first.source;
      const workId = bootstrap || businessSource.actor.kind === "human" ? captured?.work.workId : notice?.workId;
      if (!workId || (options.firstReceipts && (!captured?.binding || captured.work.workId !== workId)) ||
        (businessSource.actor.kind === "human" && (!captured ||
          (captured.basis.kind === "manual_owner_write" && (!("pluginInstanceId" in captured) ||
            captured.pluginInstanceId !== first.auth.source.extra.pluginMessage.instanceId)) ||
          (captured.basis.kind === "standing_grant" && captured.basis.producer !== "standing_work")))) throw changed();
      const read = () =>
        connector.withAssignedWorkAuthority(first.source.connectionId, workId, async (scope) => {
          const current = await readNative(action);
          if (!isDeepStrictEqual(current, first)) throw changed();
          const { auth } = current;
          const source = bootstrap ? captured!.source.identity : current.source;
          const sourceId = bootstrap ? captured!.source.id : auth.source.id;
          const sourceMessage = bootstrap ? await options.firstReceipts!.messaging.get!(sourceId) : auth.source;
          await action.assertCurrent();
          if (!sourceMessage || !sourceMessage.source || sourceMessage.source.connector !== "collective" ||
            sourceMessage.id !== sourceId || sourceMessage.userId !== auth.userId || sourceMessage.catId !== null ||
            !isDeepStrictEqual(sourceMessage.source.meta?.participation, source)) throw changed();
          const materialSnapshots: PluginMessage[] = [];
          const task = await context.tasks.get(auth.task.taskRef.slice("task:work:".length));
          await action.assertCurrent();
          const work = await scope.readCurrentWork();
          await action.assertCurrent();
          const route = await connector.getHostRoute(source.connectionId);
          const connection = await connector.getProjection(source.connectionId);
          const inbox = await connector.listInbox(source.connectionId);
          const sources = inbox.filter((row) => row.event.eventId === source.eventId);
          const actual = sources.length === 1 ? sources[0] : undefined;
          const assignment = inbox.filter((row) => row.event.eventId === work.assignmentEventId);
          const firstReceipt = assignment.length === 1 ? assignment[0]?.routeReceipt : undefined;
          const participation =
            route &&
            connection.authorizedHumanId &&
            resolveMaterializedParticipation(
              route,
              connection.authorizedHumanId,
              auth.catId,
              source.location.channelId,
            );
          if (
            !task ||
            `task:work:${task.id}` !== auth.task.taskRef ||
            task.kind !== "work" ||
            task.userId !== auth.userId ||
            task.ownerCatId !== auth.catId ||
            task.threadId !== auth.threadId ||
            task.status === "done" ||
            task.entrustedWork?.closure.state !== "open" ||
            firstReceipt?.kind !== "thread_message" ||
            task.entrustedWork.admission.sourceRefs.length !== 1 ||
            task.entrustedWork.admission.sourceRefs[0] !== `message:${firstReceipt.messageId}` ||
            !actual ||
            !isDeepStrictEqual(collectiveEventSourceIdentity(actual.event), source) ||
            actual.event.body !== sourceMessage.content ||
            sourceMessage.source.meta?.workRequest !== actual.event.workRequest ||
            !isDeepStrictEqual(sourceMessage.source.meta?.workAcceptanceNotice, actual.event.workAcceptanceNotice) ||
            !isDeepStrictEqual(sourceMessage.source.meta?.workExecutionNotice, actual.event.workExecutionNotice) ||
            !isDeepStrictEqual(sourceMessage.source.meta?.workRevisionNotice, actual.event.workRevisionNotice) ||
            actual.routeReceipt?.kind !== "thread_message" ||
            actual.routeReceipt.messageId !== sourceId ||
            actual.routeReceipt.threadId !== sourceMessage.threadId ||
            actual.routeReceipt.catId !== auth.catId ||
            route?.localOwnerUserId !== auth.userId ||
            connection.authorityStatus !== "connected" ||
            connection.authorizedHumanId !== work.accountableHumanId ||
            !participation ||
            participation.threadId !== sourceMessage.threadId ||
            !work.assignmentEventId ||
            !["committed", "in_progress", "result_ready"].includes(work.lifecycle)
          )
            throw changed();
          // These are the source's issued round, not the latest Work numbers silently
          // substituted into an older invocation after a result/reconsideration change.
          const continued = actual.event.workRequest === "continue";
          const executionRevision = continued ? actual.event.workExecutionNotice?.revision : 1;
          const resultRevision = continued ? actual.event.workExecutionNotice?.resultRevision : 1;
          const expectedResult =
            work.executionAuthority?.resultRevision ??
            (work.lifecycle === "result_ready"
              ? (work.resultRevision ?? 1)
              : (work.resultEventId ? (work.resultRevision ?? 1) : 0) + 1);
          if (
            !executionRevision ||
            !resultRevision ||
            resultRevision !== expectedResult ||
            (continued
              ? !collectiveWorkExecutionMatches(source, work, sourceMessage.source.meta?.workExecutionNotice)
              : actual.event.workRequest !== "entrust" ||
                (work.executionAuthority?.revision ?? 1) !== 1 ||
                !collectiveWorkAssignmentMatches(source, work, sourceMessage.source.meta?.workAcceptanceNotice))
          )
            throw changed();
          if (captured) {
            const ports = options.firstReceipts;
            if (!ports?.messaging.get || !captured.binding) throw changed();
            const stored = await readWorkExecutionReceipt(ports.storage, auth.userId, sourceId, auth.catId);
            const message = await ports.messaging.get(sourceId);
            await action.assertCurrent();
            if (!isDeepStrictEqual(stored, captured) || !message ||
              captured.source.revision !== message.sourceRevision || captured.source.id !== message.id ||
              captured.source.threadId !== message.threadId || message.userId !== auth.userId || message.catId !== null ||
              captured.source.bodyDigest !== workReceiptDigest(message.content) || message.content !== sourceMessage.content ||
              !isDeepStrictEqual(captured.source.identity, source) || captured.work.assignmentEventId !== work.assignmentEventId ||
              captured.work.resultRevision !== resultRevision || captured.work.executionRevision !== executionRevision ||
              captured.work.intendedOutcomeDigest !== workReceiptDigest(work.intendedOutcome) ||
              captured.binding.taskRef !== auth.task.taskRef || captured.binding.taskRevision !== auth.task.taskRevision ||
              captured.binding.threadId !== auth.threadId || captured.binding.admissionRef !== auth.task.admissionRef ||
              captured.binding.executionRef !== auth.task.executionRef ||
              captured.binding.refScope !== `message:${sourceId}:work:${task.id}:${auth.task.taskRevision}:result:${resultRevision}:execution:${executionRevision}:${auth.task.executionRef}`)
              throw changed();
            materialSnapshots.push(message);
            if (continued) {
              if (!("firstSourceMessageId" in captured) || typeof captured.firstSourceMessageId !== "string" ||
                !("kind" in captured) || captured.kind !== "continued_execution" ||
                captured.firstSourceMessageId !== firstReceipt.messageId || source.actor.kind !== "agent") throw changed();
              const root = await readWorkLineageReceipt(ports.storage, auth.userId, captured.firstSourceMessageId, auth.catId);
              const rootMessage = await ports.messaging.get(captured.firstSourceMessageId); await action.assertCurrent();
              if (!root?.binding ||
                root.work.workId !== work.workId || root.work.assignmentEventId !== work.assignmentEventId ||
                root.binding.taskRef !== auth.task.taskRef || root.binding.threadId !== auth.threadId ||
                root.binding.admissionRef !== auth.task.admissionRef || !rootMessage || rootMessage.userId !== auth.userId ||
                rootMessage.catId !== null || rootMessage.id !== root.source.id || rootMessage.threadId !== root.source.threadId ||
                rootMessage.sourceRevision !== root.source.revision || workReceiptDigest(rootMessage.content) !== root.source.bodyDigest ||
                !isDeepStrictEqual(rootMessage.source?.meta?.participation, root.source.identity) ||
                !collectiveWorkAssignmentMatches(root.source.identity, work, rootMessage.source?.meta?.workAcceptanceNotice) ||
                rootMessage.source?.meta?.workRequest !== "entrust" ||
                (bootstrap && (!isDeepStrictEqual(root, bootstrap) || auth.source.id !== root.source.id ||
                  auth.source.content !== rootMessage.content || auth.source.threadId !== rootMessage.threadId ||
                  !isDeepStrictEqual(auth.source.source, {connector: rootMessage.source?.connector, meta: rootMessage.source?.meta})))) throw changed();
              materialSnapshots.push(rootMessage);
            } else if ("kind" in captured) throw changed();
          }
          if (source.actor.kind === "agent") {
            const grant = await connector.resolveAcceptedWorkGrant(source);
            await action.assertCurrent();
            const authority = grant.work.executionAuthority ?? grant.work.acceptance;
            if (
              grant.work.workId !== work.workId ||
              grant.work.assignmentEventId !== work.assignmentEventId ||
              !isDeepStrictEqual(grant.work.executionAuthority, work.executionAuthority) ||
              !isDeepStrictEqual(grant.work.acceptance, work.acceptance) ||
              authority?.hostAdmission?.state !== "admitted" ||
              authority.hostAdmission.receiptRef !== opaqueHostAdmission({userId: auth.userId, id: sourceId}, work.workId, task.id)
            ) throw changed();
            if (captured && (captured.basis.kind !== "standing_grant" || captured.basis.producer !== "registered_work" ||
              captured.basis.grantRef !== grant.grant.grantRef || captured.basis.grantRevision !== grant.grant.grantRevision ||
              captured.basis.requestKind !== authority.requestKind || captured.basis.operationRef !== authority.operationRef ||
              !isDeepStrictEqual(captured.basis.originalSource, grant.originalSource) ||
              captured.basis.expiresAt !== grant.grant.expiresAt)) throw changed();
          }
          if (source.actor.kind === "human" && captured?.basis.kind === "standing_grant") {
            const basis = await resolveHumanStandingWorkBasis(connector, source, auth.userId);
            await action.assertCurrent();
            if (!basis || !isDeepStrictEqual(captured.basis, basis)) throw changed();
          }
          await action.assertCurrent();
          const latest = await readNative(action);
          if (!isDeepStrictEqual(latest, current)) throw changed();
          // Bootstrap Host currentness covers its first source. Its current
          // business source is a separate owned message; recheck both after
          // awaited Service/Registry work before handing control to a consumer.
          if (captured && options.firstReceipts) {
            const finalReceipt = await readWorkExecutionReceipt(options.firstReceipts.storage,
              auth.userId, sourceId, auth.catId);
            if (!isDeepStrictEqual(finalReceipt, captured)) throw changed();
            if (bootstrap && !isDeepStrictEqual(await readWorkLineageReceipt(options.firstReceipts.storage,
              auth.userId, bootstrap.source.id, auth.catId), bootstrap)) throw changed();
            for (const snapshot of materialSnapshots) {
              await action.assertCurrent();
              if (!isDeepStrictEqual(await options.firstReceipts.messaging.get!(snapshot.id), snapshot)) throw changed();
            }
          }
          return {
            auth,
            source,
            sourceRef: `message:${sourceId}` as const,
            resultKey: `work:${task.id}`,
            displayName: participation.displayName,
            work: {
              workId: work.workId,
              // Host assertCurrent/readTaskBinding fence execution authority. Its
              // captured Task revision stays fixed while evidence-only metadata
              // advances the aggregate CAS revision; the two are different facts.
              revision: auth.task.taskRevision,
              resultRevision,
              executionRevision,
              assignmentEventId: work.assignmentEventId,
            },
            refScope: `message:${sourceId}:work:${task.id}:${auth.task.taskRevision}:result:${resultRevision}:execution:${executionRevision}:${auth.task.executionRef}`,
          };
        });
      const initial = await read();
      let live = true;
      const revalidate = async () => {
        if (!live) throw new Error("Private Task consumer scope has ended");
        const current = await read();
        if (!live) throw new Error("Private Task consumer scope has ended");
        if (!isDeepStrictEqual(current, initial)) throw changed();
      };
      // Original callback effects own their own Connector transaction (notably
      // progress sync). Read/revalidate under the fence; do not retain it across
      // that operation or manufacture a second synchronization entry point.
      try {
        const result = await consume(Object.freeze({ ...initial, revalidate }));
        await revalidate();
        return result;
      } finally {
        live = false;
      }
    },
  });
}
