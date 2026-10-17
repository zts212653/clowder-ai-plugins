import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  PluginTaskHost,
  PluginTaskAdmissionInput,
  PluginTaskAdmissionResult,
  PluginTaskReadItem,
  PluginStorageHost,
  PluginMessagingHost,
  PluginThreadHost,
} from "@clowder-ai/plugin-sdk";
import type { AssignedWorkAuthorityScope, CollectiveConnector } from "./business/connector/connector.js";
import {
  collectiveEventSourceIdentity,
  collectiveWorkAssignmentMatches,
  collectiveWorkExecutionMatches,
  participationSourceIsCurrent,
  type CollectiveSourceIdentity,
  type CollectiveWorkProjection,
} from "./business/contracts/index.js";
import { readWorkLineageReceipt, isBootstrapWorkLineage, retainBootstrapWorkLineage, readWorkExecutionReceipt, retainWorkFirstReceipt, retainWorkContinuationReceipt, workReceiptDigest, type ManualWorkExecutionBinding, type StandingWorkFirstReceipt, type WorkLineageReceipt } from "./owner-work-first-receipt.js";
import { resolveHumanStandingWorkBasis } from "./collective-human-standing.js";
import { resolveCollectiveWorkThread, selectCollectiveWorkThread } from "./collective-work-thread.js";

export interface CollectiveWorkAdmissionSelection {
  readonly ownerUserId: string;
  readonly identity: CollectiveSourceIdentity;
  readonly sourceMessageId: string;
  readonly workId: string;
  readonly destination: PluginTaskAdmissionInput["destination"];
  readonly subject?: PluginTaskAdmissionInput["subject"];
}
interface Options {
  readonly connector: CollectiveConnector;
  readonly tasks: Pick<PluginTaskHost, "get" | "listByKind" | "prepareEntrusted" | "dispatchEntrusted">;
  readonly assertCurrent: () => Promise<void>;
  /** Original standing first/execution composition; previous Agent ack-only
   * foundation has no claim of durable bound replay or production completion. */
  readonly firstReceipts?: {
    readonly storage: Pick<PluginStorageHost, "get" | "compareAndSet">;
    readonly messaging: Pick<PluginMessagingHost, "get">;
  };
  readonly threads?: Pick<PluginThreadHost, "get" | "ensureByKey">;
}
const unavailable = (code = "WORK_EXECUTION_NOT_CURRENT") =>
  Object.assign(new Error("Current Collective Work does not authorize this Host execution"), { code });

/** Original Service receipt identity. It reports a factual Host Task; it issues no grant or bearer. */
export function opaqueHostAdmission(
  source: { readonly userId: string; readonly id: string },
  workId: string,
  fact: string,
) {
  return `host-admission:${createHash("sha256")
    .update(JSON.stringify([source.userId, source.id, workId, fact]))
    .digest("hex")}`;
}
function sameExecution(left: CollectiveWorkProjection, right: CollectiveWorkProjection) {
  const facts = (work: CollectiveWorkProjection) => ({
    workId: work.workId,
    assignment: work.assignment,
    assignmentEventId: work.assignmentEventId,
    accountableHumanId: work.accountableHumanId,
    intendedOutcome: work.intendedOutcome,
    authority: work.executionAuthority
      ? { ...work.executionAuthority, hostAdmission: undefined, hostAdmissionHistory: undefined }
      : work.acceptance
        ? { ...work.acceptance, hostAdmission: undefined, hostAdmissionHistory: undefined }
        : undefined,
  });
  return isDeepStrictEqual(facts(left), facts(right));
}
function validateScope(
  scope: AssignedWorkAuthorityScope,
  selection: CollectiveWorkAdmissionSelection,
  work = scope.work,
) {
  const source = selection.identity,
    assignment = work.assignment;
  const matches = scope.inbox.filter((item) => item.event.eventId === source.eventId);
  const item = matches.length === 1 ? matches[0] : undefined;
  if (
    !item ||
    !isDeepStrictEqual(collectiveEventSourceIdentity(item.event), source) ||
    scope.hostRoute?.localOwnerUserId !== selection.ownerUserId ||
    scope.connection.authorityStatus !== "connected" ||
    !scope.connection.authorizedHumanId ||
    work.workId !== selection.workId ||
    assignment?.connectionId !== source.connectionId ||
    work.accountableHumanId !== scope.connection.authorizedHumanId ||
    !participationSourceIsCurrent(
      scope.hostRoute,
      source.catId,
      source.location.channelId,
      source.participationRevision,
    ) ||
    item.routeReceipt?.kind !== "thread_message" ||
    item.routeReceipt.messageId !== selection.sourceMessageId ||
    item.routeReceipt.catId !== source.catId ||
    !["committed", "in_progress", "result_ready"].includes(work.lifecycle) ||
    (item.event.workRequest === "continue"
      ? !collectiveWorkExecutionMatches(source, work, item.event.workExecutionNotice)
      : item.event.workRequest !== "entrust" ||
        !collectiveWorkAssignmentMatches(source, work, item.event.workAcceptanceNotice) ||
        (work.executionAuthority?.revision ?? 1) !== 1)
  )
    throw unavailable();
  return item;
}
function validateTask(
  task: PluginTaskReadItem | null,
  result: Exclude<PluginTaskAdmissionResult, { result: "needs_clarification" }>,
  selection: CollectiveWorkAdmissionSelection,
  firstSourceRef: string,
  newlyPrepared = true,
) {
  if (
    !task ||
    `task:work:${task.id}` !== result.taskRef ||
    task.kind !== "work" ||
    task.userId !== selection.ownerUserId ||
    task.ownerCatId !== selection.identity.catId ||
    task.threadId !== result.threadId ||
    (selection.destination.kind === "existing_thread" && result.threadId !== selection.destination.threadId) ||
    task.status === "done" ||
    task.entrustedWork?.closure.state !== "open" ||
    (newlyPrepared && task.entrustedWork.revision !== result.taskRevision) ||
    task.entrustedWork.admission.sourceRefs.length !== 1 ||
    task.entrustedWork.admission.sourceRefs[0] !== firstSourceRef
  )
    throw unavailable("OWNER_ADMISSION_UNAVAILABLE");
  return task;
}

/** One original connection fence owns prepare → factual Service ack → business reread → dispatch.
 * Caller selections come from authenticated owner/native or original persisted ingress; the Host
 * independently rereads them. Generic CRUD/read and these business facts never admit execution. */
export function createCollectiveWorkAdmissionCaller(options: Options) {
  const admitInScope = async (
    scope: AssignedWorkAuthorityScope,
    raw: CollectiveWorkAdmissionSelection,
    entry: "standing" | "owner_request" = "standing",
  ) => {
    const selection = structuredClone(raw);
    let destination = selection.destination;
    await options.assertCurrent();
    const item = validateScope(scope, selection);
    const continued = item.event.workRequest === "continue";
    const authority = scope.work.executionAuthority ?? scope.work.acceptance;
    // Agent standing requires actual Service authority and acknowledgement.
    // Human standing requires a durable choice under the original owner route
    // scope. An owner click may only reuse either already bound choice.
    if ((entry === "owner_request" && !options.firstReceipts) ||
      (selection.identity.actor.kind === "agent" ? !authority : !options.firstReceipts))
      throw unavailable("OWNER_ADMISSION_UNAVAILABLE");
    if (authority?.hostAdmission?.state === "rejected") throw unavailable("OWNER_ADMISSION_UNAVAILABLE");
    let publishedSource: Awaited<ReturnType<NonNullable<PluginMessagingHost["get"]>>> | undefined;
    let standingBasis: StandingWorkFirstReceipt["basis"] | undefined;
    let firstChoice: WorkLineageReceipt | undefined;
    let firstPublished: typeof publishedSource;
    const current = async () => {
      await options.assertCurrent();
      const work = await scope.readCurrentWork();
      await options.assertCurrent();
      const route = await options.connector.getHostRoute(selection.identity.connectionId);
      const connection = await options.connector.getProjection(selection.identity.connectionId);
      const inbox = await options.connector.listInbox(selection.identity.connectionId);
      await options.assertCurrent();
      validateScope({ ...scope, connection, hostRoute: route, inbox }, selection, work);
      if (!sameExecution(scope.work, work)) throw unavailable();
      if ((work.executionAuthority ?? work.acceptance)?.hostAdmission?.state === "rejected")
        throw unavailable("OWNER_ADMISSION_UNAVAILABLE");
      let basis: StandingWorkFirstReceipt["basis"];
      if (selection.identity.actor.kind === "agent") {
        const grant = await options.connector.resolveAcceptedWorkGrant(selection.identity);
        await options.assertCurrent();
        if (!sameExecution(work, grant.work) || !authority) throw unavailable();
        basis = {kind: "standing_grant", producer: "registered_work", grantRef: grant.grant.grantRef,
          grantRevision: grant.grant.grantRevision, requestKind: authority.requestKind,
          operationRef: authority.operationRef, originalSource: grant.originalSource, expiresAt: grant.grant.expiresAt};
      } else {
        const resolved = await resolveHumanStandingWorkBasis(options.connector, selection.identity, selection.ownerUserId);
        await options.assertCurrent();
        if (!resolved) throw unavailable("OWNER_ADMISSION_UNAVAILABLE");
        basis = resolved;
      }
      if (standingBasis && !isDeepStrictEqual(standingBasis, basis)) throw unavailable();
      standingBasis = basis;
      if (options.firstReceipts) {
        if (!options.firstReceipts.messaging.get) throw unavailable();
        const message = await options.firstReceipts.messaging.get(selection.sourceMessageId);
        await options.assertCurrent();
        if (!message || message.id !== selection.sourceMessageId || message.userId !== selection.ownerUserId ||
          message.catId !== null || item.routeReceipt?.kind !== "thread_message" ||
          message.threadId !== item.routeReceipt.threadId ||
          message.content !== item.event.body || message.source?.connector !== "collective" ||
          !isDeepStrictEqual(message.source.meta?.participation, selection.identity) ||
          message.source.meta?.workRequest !== item.event.workRequest ||
          !isDeepStrictEqual(message.source.meta?.workAcceptanceNotice, item.event.workAcceptanceNotice) ||
          !isDeepStrictEqual(message.source.meta?.workExecutionNotice, item.event.workExecutionNotice) ||
          (publishedSource && (publishedSource.sourceRevision !== message.sourceRevision ||
            publishedSource.threadId !== message.threadId || publishedSource.content !== message.content))) throw unavailable();
        publishedSource = message;
        if (continued) {
          if (selection.identity.actor.kind !== "agent" || !work.executionAuthority || work.executionAuthority.revision <= 1)
            throw unavailable("WORK_TASK_UNAVAILABLE");
          const firstItems = inbox.filter(row => row.event.eventId === work.assignmentEventId);
          const receipt = firstItems.length === 1 ? firstItems[0]?.routeReceipt : undefined;
          if (receipt?.kind !== "thread_message") throw unavailable("WORK_TASK_UNAVAILABLE");
          const firstItem = firstItems[0]!;
          const firstIdentity = collectiveEventSourceIdentity(firstItem.event);
          const first = await readWorkLineageReceipt(options.firstReceipts.storage, selection.ownerUserId,
            receipt.messageId, selection.identity.catId);
          const root = await options.firstReceipts.messaging.get(receipt.messageId);
          await options.assertCurrent();
          if (!firstIdentity || firstItem.event.workRequest !== "entrust" ||
            !collectiveWorkAssignmentMatches(firstIdentity, work, firstItem.event.workAcceptanceNotice) ||
            !root || root.id !== receipt.messageId || root.userId !== selection.ownerUserId || root.catId !== null ||
            root.threadId !== receipt.threadId || root.content !== firstItem.event.body || root.source?.connector !== "collective" ||
            !isDeepStrictEqual(root.source.meta?.participation, firstIdentity) || root.source.meta?.workRequest !== "entrust" ||
            !isDeepStrictEqual(root.source.meta?.workAcceptanceNotice, firstItem.event.workAcceptanceNotice) ||
            (firstPublished && !isDeepStrictEqual(firstPublished, root)) ||
            (firstChoice && (!first || !isDeepStrictEqual({...firstChoice, binding: undefined}, {...first, binding: undefined}) ||
              (firstChoice.binding && !isDeepStrictEqual(firstChoice.binding, first.binding))))) throw unavailable("WORK_TASK_UNAVAILABLE");
          // The immutable first choice may be Human manual/standing. Current
          // registered permission above authorizes this continuation; the old
          // choice contributes lineage/binding, never its previous grant.
          if (first && (
            (!isBootstrapWorkLineage(first) && !first.binding) ||
            root.threadId !== first.source.threadId || root.sourceRevision !== first.source.revision ||
            workReceiptDigest(root.content) !== first.source.bodyDigest ||
            !isDeepStrictEqual(first.source.identity, firstIdentity) ||
            first.work.workId !== work.workId || first.work.assignmentEventId !== work.assignmentEventId ||
            first.work.executionRevision !== 1 || first.work.resultRevision !== 1 ||
            first.work.intendedOutcomeDigest !== workReceiptDigest(work.intendedOutcome))) throw unavailable("WORK_TASK_UNAVAILABLE");
          firstPublished = root;
          firstChoice = first;
        }
      }
      return work;
    };
    await current();
    if (!options.tasks.prepareEntrusted || !options.tasks.dispatchEntrusted)
      throw unavailable("OWNER_ADMISSION_UNAVAILABLE");
    let durableFirst: Awaited<ReturnType<typeof retainWorkFirstReceipt>> | Awaited<ReturnType<typeof retainWorkContinuationReceipt>> | undefined;
    let bound: ManualWorkExecutionBinding | undefined;
    let bootstrapLineage: Awaited<ReturnType<typeof retainBootstrapWorkLineage>> | undefined;
    const bootstrapping = continued && (!firstChoice || (isBootstrapWorkLineage(firstChoice) &&
      firstChoice.bootstrapSourceMessageId === selection.sourceMessageId));
    let prepareSourceMessageId = selection.sourceMessageId;
    let continuedSubject: PluginTaskAdmissionInput["subject"] | undefined;
    if (options.firstReceipts) {
      // Later Service executions need their own receipt referring to this first
      // choice. Do not silently recapture a new source as the first admission.
      if (!publishedSource || !standingBasis || !options.threads || !scope.work.assignmentEventId ||
        (!continued && (item.event.workRequest !== "entrust" || (scope.work.executionAuthority?.revision ?? 1) !== 1)))
        throw unavailable("WORK_TASK_UNAVAILABLE");
      if (entry === "owner_request") {
        const prior = await readWorkExecutionReceipt(options.firstReceipts.storage, selection.ownerUserId,
          selection.sourceMessageId, selection.identity.catId);
        await current();
        if (prior?.basis.kind !== "standing_grant" || !prior.binding) throw unavailable("OWNER_ADMISSION_UNAVAILABLE");
      }
      if (continued) {
        const authority = scope.work.executionAuthority;
        if (!authority || standingBasis.producer !== "registered_work" || !firstPublished)
          throw unavailable("WORK_TASK_UNAVAILABLE");
        if (bootstrapping) {
          if (selection.subject && selection.subject.kind !== "new") throw unavailable("WORK_TASK_UNAVAILABLE");
          const tasks = await options.tasks.listByKind("work"); await current();
          const site = selectCollectiveWorkThread(tasks, firstPublished, selection.identity.catId);
          // An existing Task without a pre-effect lineage must never be recaptured.
          if (!firstChoice && site.kind === "existing") throw unavailable("WORK_TASK_UNAVAILABLE");
          bootstrapLineage = await retainBootstrapWorkLineage(options.firstReceipts.storage, {
            v: 1, kind: "bootstrap_lineage", bootstrapSourceMessageId: selection.sourceMessageId,
            ownerUserId: selection.ownerUserId,
            source: {id: firstPublished.id, revision: firstPublished.sourceRevision, threadId: firstPublished.threadId,
              bodyDigest: workReceiptDigest(firstPublished.content), identity: collectiveEventSourceIdentity(
                scope.inbox.find(row => row.event.eventId === scope.work.assignmentEventId)!.event)!},
            work: {workId: scope.work.workId, assignmentEventId: scope.work.assignmentEventId!, resultRevision: 1,
              executionRevision: 1, intendedOutcomeDigest: workReceiptDigest(scope.work.intendedOutcome)},
          }, async () => {await current();});
          const rootBinding = await bootstrapLineage.readBinding();
          const threadId = rootBinding?.threadId ?? await resolveCollectiveWorkThread(options.threads,
            options.tasks, firstPublished, selection.identity.catId);
          await current();
          if (selection.destination.kind === "existing_thread" && selection.destination.threadId !== threadId)
            throw unavailable("WORK_TASK_UNAVAILABLE");
          destination = {kind: "existing_thread", threadId};
          prepareSourceMessageId = firstPublished.id;
        } else {
          const first = firstChoice;
          if (!first?.binding) throw unavailable("WORK_TASK_UNAVAILABLE");
          const task = await options.tasks.get(first.binding.taskRef.slice("task:work:".length)); await current();
          if (!task || task.kind !== "work" || task.userId !== selection.ownerUserId || task.ownerCatId !== selection.identity.catId ||
            task.threadId !== first.binding.threadId || task.status === "done" || task.entrustedWork?.closure.state !== "open" ||
            task.entrustedWork.admission.sourceRefs.length !== 1 || task.entrustedWork.admission.sourceRefs[0] !== `message:${first.source.id}` ||
            (selection.destination.kind === "existing_thread" && selection.destination.threadId !== task.threadId) ||
            (selection.subject && (selection.subject.kind !== "continue" || selection.subject.taskRef !== first.binding.taskRef)))
            throw unavailable("WORK_TASK_UNAVAILABLE");
          destination = {kind: "existing_thread", threadId: task.threadId};
          continuedSubject = {kind: "continue", taskRef: first.binding.taskRef, expectedRevision: task.entrustedWork.revision};
        }
        durableFirst = await retainWorkContinuationReceipt(options.firstReceipts.storage, {
          v: 1, kind: "continued_execution", firstSourceMessageId: firstPublished.id, ownerUserId: selection.ownerUserId,
          basis: standingBasis,
          source: {id: publishedSource.id, revision: publishedSource.sourceRevision, threadId: publishedSource.threadId,
            bodyDigest: workReceiptDigest(publishedSource.content), identity: selection.identity},
          work: {workId: scope.work.workId, assignmentEventId: scope.work.assignmentEventId!,
            resultRevision: authority.resultRevision, executionRevision: authority.revision,
            intendedOutcomeDigest: workReceiptDigest(scope.work.intendedOutcome)},
        }, async () => {await current();});
        const rootBinding = firstChoice?.binding ?? await bootstrapLineage?.readBinding();
        const currentBinding = await durableFirst.readBinding();
        if (currentBinding && rootBinding && (currentBinding.taskRef !== rootBinding.taskRef ||
          currentBinding.threadId !== rootBinding.threadId || currentBinding.admissionRef !== rootBinding.admissionRef ||
          (bootstrapping && !isDeepStrictEqual(currentBinding, rootBinding)))) throw unavailable("WORK_TASK_UNAVAILABLE");
        bound = currentBinding ?? (bootstrapping ? rootBinding : undefined);
      } else {
      const tasks = await options.tasks.listByKind("work");await current();
      const site = selectCollectiveWorkThread(tasks, publishedSource, selection.identity.catId);
      durableFirst = await retainWorkFirstReceipt(options.firstReceipts.storage, {
        v: 1, ownerUserId: selection.ownerUserId,
        basis: standingBasis,
        source: {id: publishedSource.id, revision: publishedSource.sourceRevision, threadId: publishedSource.threadId,
          bodyDigest: workReceiptDigest(publishedSource.content), identity: selection.identity},
        work: {workId: scope.work.workId, assignmentEventId: scope.work.assignmentEventId, resultRevision: 1,
          executionRevision: 1, intendedOutcomeDigest: workReceiptDigest(scope.work.intendedOutcome)},
      }, async () => {await current();}, site.kind === "existing");
      bound = await durableFirst.readBinding();
      if (bound) {
        if (selection.destination.kind === "existing_thread" && selection.destination.threadId !== bound.threadId)
          throw unavailable("OWNER_ADMISSION_CONFLICT");
        destination = {kind: "existing_thread", threadId: bound.threadId};
      } else {
        const threadId = await resolveCollectiveWorkThread(options.threads, options.tasks, publishedSource, selection.identity.catId);
        await current();
        if (selection.destination.kind === "existing_thread" && selection.destination.threadId !== threadId)
          throw unavailable("OWNER_ADMISSION_CONFLICT");
        destination = {kind: "existing_thread", threadId};
      }
      }
    }
    const subject = continuedSubject ?? selection.subject ?? {
      kind: "new" as const,
      title: scope.work.title.slice(0, 160),
      intendedOutcome: scope.work.intendedOutcome,
      closure: {
        condition: "A reviewable result answers the entrusted request at its original Collective location",
        expectedSignal: "collective:accepted-result",
      },
    };
    if (continued && !bootstrapping && subject.kind !== "continue")
      throw unavailable("WORK_TASK_UNAVAILABLE");
    await current();
    const result = bound ? {result: "resumed" as const, taskRef: bound.taskRef, taskRevision: bound.taskRevision,
      threadId: bound.threadId, admissionRef: bound.admissionRef, executionRef: bound.executionRef}
      : await options.tasks.prepareEntrusted({
      sourceMessageId: prepareSourceMessageId,
      targetCatId: selection.identity.catId,
      destination,
      subject,
    });
    await current();
    if (result.result === "needs_clarification") return result;
    const first = scope.inbox.filter((row) => row.event.eventId === scope.work.assignmentEventId);
    const firstReceipt = first.length === 1 ? first[0]?.routeReceipt : undefined;
    if (firstReceipt?.kind !== "thread_message") throw unavailable("WORK_TASK_UNAVAILABLE");
    const task = validateTask(
      await options.tasks.get(result.taskRef.slice(10)),
      result,
      {...selection, destination},
      `message:${firstReceipt.messageId}`,
      !bound,
    );
    await current();
    if (!scope.work.assignmentEventId) throw unavailable();
    const binding = {taskRef: result.taskRef, taskRevision: result.taskRevision, threadId: result.threadId,
      admissionRef: result.admissionRef, executionRef: result.executionRef,
      refScope: `message:${selection.sourceMessageId}:work:${task.id}:${result.taskRevision}:result:${continued ? scope.work.executionAuthority!.resultRevision : 1}:execution:${continued ? scope.work.executionAuthority!.revision : 1}:${result.executionRef}`};
    await bootstrapLineage?.bind(binding);
    if (durableFirst) await durableFirst.bind(binding);
    const receiptRef = opaqueHostAdmission(
      { userId: selection.ownerUserId, id: selection.sourceMessageId },
      scope.work.workId,
      task.id,
    );
    if (selection.identity.actor.kind === "agent") {
      if (!authority) throw unavailable();
      await scope.recordHostAdmission({
        workId: scope.work.workId,
        assignmentEventId: scope.work.assignmentEventId,
        operationRef: authority.operationRef,
        grantRef: authority.grantRef,
        grantRevision: authority.grantRevision,
        executionRevision: scope.work.executionAuthority?.revision ?? 1,
        disposition: { state: "admitted", receiptRef },
      });
      const fresh = await current();
      const acknowledgement = (fresh.executionAuthority ?? fresh.acceptance)?.hostAdmission;
      if (acknowledgement?.state !== "admitted" || acknowledgement.receiptRef !== receiptRef)
        throw unavailable("OWNER_ADMISSION_UNAVAILABLE");
    } else await current();
    // Re-read the actual canonical Task and the current remote business grant after the Service effect.
    validateTask(await options.tasks.get(task.id), result, {...selection, destination}, `message:${firstReceipt.messageId}`, !bound);
    await current();
    await durableFirst?.assertBound(binding);
    await bootstrapLineage?.assertBound(binding);
    const queue = await options.tasks.dispatchEntrusted({
      taskRef: result.taskRef,
      taskRevision: result.taskRevision,
      executionRef: result.executionRef,
    });
    await current();
    await durableFirst?.assertBound(binding);
    await bootstrapLineage?.assertBound(binding);
    return { ...result, queue };
  };
  return Object.freeze({
    admitInScope,
    async admit(raw: CollectiveWorkAdmissionSelection) {
      const selection = structuredClone(raw);
      await options.assertCurrent();
      return options.connector.withAssignedWorkAuthority(selection.identity.connectionId, selection.workId, (scope) =>
        admitInScope(scope, selection),
      );
    },
  });
}
