import type { CollectiveEventEnvelope, CollectiveParticipationDeclaration } from '../contracts/index.js';
/** Private, authenticated same-instance snapshot. Never obtained via GET poll or unauthenticated projection. */
export interface LocalRecoverySnapshot {
  readonly serviceInstanceId: string;
  readonly collectiveId: string;
  readonly connectionId: string;
  readonly endpointId: string;
  readonly authorizedHumanId: string;
  readonly status: 'connected' | 'revoked';
  readonly lastAckedSequence: number;
  readonly lastDeliveredSequence: number;
  readonly declaration: CollectiveParticipationDeclaration | null;
  readonly event?: CollectiveEventEnvelope;
}
export interface RecoveryOwnerContext {
  readonly userId: string;
  assertCurrent(): Promise<void>;
}
export type LocalRecoveryProof<T> = { readonly outcome: 'confirmed'; readonly value: T } |
  { readonly outcome: 'replay_safe' | 'unresolved' };
