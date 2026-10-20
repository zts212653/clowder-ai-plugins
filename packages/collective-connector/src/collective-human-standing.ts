import type { CollectiveConnector } from "./business/connector/connector.js";
import { participationSourceIsCurrent, type CollectiveSourceIdentity } from "./business/contracts/index.js";
import type { StandingWorkFirstReceipt } from "./owner-work-first-receipt.js";

/** Original ca5 human standing resolver. The remote source and existing owner
 * route are the authority; this projection neither issues a grant nor selects
 * a thread. readParticipationContext has no connection writer-tail reentry. */
export async function resolveHumanStandingWorkBasis(
  connector: CollectiveConnector, source: CollectiveSourceIdentity, ownerUserId: string,
): Promise<Extract<StandingWorkFirstReceipt["basis"], {producer: "standing_work"}> | undefined> {
  if (source.actor.kind !== "human") return undefined;
  await connector.readParticipationContext(source, 0, 1);
  const route = await connector.getHostRoute(source.connectionId);
  const connection = await connector.getProjection(source.connectionId);
  const branch = route?.agentRoutes[`${connection.authorizedHumanId}:${source.catId}`];
  const scope = branch?.standingWork;
  const revision = branch?.standingWorkRevision ?? route?.revision;
  if (!route || route.localOwnerUserId !== ownerUserId || connection.authorityStatus !== "connected" ||
    !connection.authorizedHumanId || !revision || !scope ||
    !participationSourceIsCurrent(route, source.catId, source.location.channelId, source.participationRevision) ||
    !scope.requestingHumanIds.includes(source.actor.humanId) || !scope.channelIds.includes(source.location.channelId) ||
    (scope.expiresAt !== null && Date.parse(scope.expiresAt) <= Date.now())) return undefined;
  return {kind: "standing_grant", producer: "standing_work",
    grantRef: `collective-host:${source.connectionId}:${source.catId}`, grantRevision: revision,
    scope: structuredClone(scope)};
}
