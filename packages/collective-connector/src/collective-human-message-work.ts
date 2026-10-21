import {isDeepStrictEqual} from 'node:util';
import type {FeatureContext, PluginMessage, PluginOwnerHttpContext, PluginTaskWorkTime} from '@clowder-ai/plugin-sdk';
import type {CollectiveConnector} from './business/connector/connector.js';
import {collectiveWorkAssignmentMatches, participationSourceIsCurrent,
  type CollectiveSourceIdentity} from './business/contracts/index.js';
import {resolveHumanStandingWorkBasis} from './collective-human-standing.js';
import {collectiveWorkContinuation} from './owner-work-continuation.js';
import {classifyEntrustedWorkSourceTime} from './work-source-signals.js';
import {readWorkFirstReceipt, retainWorkFirstReceipt, workReceiptDigest} from './owner-work-first-receipt.js';

const unavailable = (): never => {throw Object.assign(new Error('Current committed Human Work or owner choice is unavailable'),
  {code: 'OWNER_ADMISSION_UNAVAILABLE'});};

/** Original Human commitment + manual/standing choice. Reuses the existing
 * private first-choice container; no Host execution selectors are generated. */
export async function resolveHumanMessageWork(connector: CollectiveConnector,
  storage: FeatureContext['storage'], source: CollectiveSourceIdentity, message: PluginMessage,
  ownerUserId: string, current: () => Promise<void>,
  options: {mode: 'read' | 'send'; hasTask: boolean; manual?: PluginOwnerHttpContext; resume?: boolean; time?: PluginTaskWorkTime}) {
  if (source.actor.kind !== 'human') return unavailable();
  await current();await connector.readParticipationContext(source, 0, 1);await current();
  const assignment = await connector.readAssignedWorkByAssignment(source.connectionId, source.eventId);await current();
  return connector.withAssignedWorkAuthority(source.connectionId, assignment.workId, async scope => {
    await current();
    const {connection, hostRoute, work} = scope;
    const item = scope.inbox.find(item => item.event.eventId === source.eventId);
    if (!hostRoute || hostRoute.localOwnerUserId !== ownerUserId || connection.authorityStatus !== 'connected' ||
      connection.authorizedHumanId !== work.accountableHumanId ||
      !participationSourceIsCurrent(hostRoute, source.catId, source.location.channelId, source.participationRevision) ||
      !collectiveWorkAssignmentMatches(source, work) || (work.executionAuthority?.revision ?? 1) !== 1 ||
      !['committed', 'in_progress', 'result_ready'].includes(work.lifecycle) ||
      !['ready', 'in_progress', 'result_ready'].includes(work.status) || item?.routeReceipt?.kind !== 'thread_message' ||
      item.routeReceipt.messageId !== message.id || item.routeReceipt.threadId !== message.threadId ||
      item.routeReceipt.catId !== source.catId || message.userId !== ownerUserId) return unavailable();
    // Original standing admission supplied no typed time fact: the Lifecycle
    // rejected unresolved source time before Task/wake. Keep that business
    // outcome while explicit owner deadlines retain their original data path.
    if ([work.intendedOutcome, message.content].some(text => {
      const relation = classifyEntrustedWorkSourceTime(text);
      return relation === 'ambiguous' || (relation === 'deadline' &&
        !(options.time?.businessDeadline?.sourceRef === `message:${message.id}` && options.time.businessDeadline.value > 0));
    })) return unavailable();
    const captured = await readWorkFirstReceipt(storage, ownerUserId, message.id, source.catId);await current();
    let basis = captured?.basis;
    if (basis?.kind !== 'manual_owner_write') {
      const standing = await resolveHumanStandingWorkBasis(connector, source, ownerUserId);await current();
      if (captured && !isDeepStrictEqual(captured.basis, standing)) return unavailable();
      basis = standing;
    }
    const manual = options.manual;
    if (!basis && manual?.kind === 'owner-http-request' && manual.operation === 'write' &&
      manual.userId === ownerUserId && manual.requestIdentity) basis = {kind: 'manual_owner_write'};
    if (!basis || (options.mode === 'send' && basis.kind === 'manual_owner_write' && !manual && !options.resume))
      return unavailable();
    const selected = {v: 1 as const, ownerUserId,
      source: {id: message.id, revision: message.sourceRevision, threadId: message.threadId,
        bodyDigest: workReceiptDigest(message.content), identity: source},
      work: {workId: work.workId, assignmentEventId: work.assignmentEventId!, resultRevision: 1,
        executionRevision: 1, intendedOutcomeDigest: workReceiptDigest(work.intendedOutcome)}};
    if (captured) {
      if (!isDeepStrictEqual(captured.source, selected.source) ||
        !isDeepStrictEqual(captured.work, selected.work)) return unavailable();
    }
    let retention: Awaited<ReturnType<typeof retainWorkFirstReceipt>> | undefined;
    if (options.mode === 'send' && captured) {
      const replay = {...captured};delete replay.binding;
      retention = await retainWorkFirstReceipt(storage, replay, current, options.hasTask);
    } else if (!captured) {
      if (options.mode !== 'send') return unavailable();
      if (basis.kind === 'manual_owner_write') {
        const request = manual?.requestIdentity;if (!request || !manual) return unavailable();
        retention = await retainWorkFirstReceipt(storage, {...selected, basis, pluginInstanceId: manual.pluginInstanceId,
          firstRequest: {requestId: request.requestId, contributionId: request.contributionId, method: request.method,
            path: request.path, bodyDigest: request.bodyDigest, queryDigest: request.queryDigest}}, current, options.hasTask);
      } else retention = await retainWorkFirstReceipt(storage, {...selected, basis}, current, options.hasTask);
    }
    await current();
    const resultRevision = work.lifecycle === 'result_ready' ? work.resultRevision ?? 1
      : collectiveWorkContinuation(scope, source, message.id).resultRevision;
    return {work, resultRevision, binding: captured?.binding,
      ...(retention ? {bindTask: retention.bind} : {})};
  });
}
