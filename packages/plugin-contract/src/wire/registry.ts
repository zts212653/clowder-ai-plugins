/**
 * P-1a wire-protocol method registry — machine truth for the 12 reserved
 * production names co-signed on zts212653/clowder-ai#1165 (maintainer R2
 * decision 5001381702; shape corrections tracked through R3 5004451129).
 *
 * Status: **reservation-only** (D0 = Option A). `shape-approved` has NOT
 * been recorded; every row is `ready: false`, unpublished, unadvertised.
 * The `ready` field is the literal type `false` on purpose: flipping a row
 * to ready is a type-level contract change that can only happen through a
 * reviewed shape/publication delta, never a runtime toggle. A row may flip
 * only after its exact UTF-8/JSON validators, generated
 * `maxEncoded{Request,Result,Error}Bytes`, N/N+1 raw-byte conformance, and
 * the three-stage runtime enforcement pass.
 *
 * Truth source: docs/plans/2026-07-17-m0-standalone-io-plan.md (R22) —
 * itself pinned to the live #1165 body. This module defines nothing new.
 */

export type WireDirection = 'plugin_to_host' | 'host_to_plugin';

export type WireGrant =
  | 'protocol-intrinsic'
  | 'messaging.send'
  | 'messaging.appendElements'
  | 'message.event.subscribe'
  | 'onMessage';

/**
 * Per-row settlement key source, verbatim from the canonical b32170a8
 * matrix as corrected on #1165. `kind: 'none'` rows must prove
 * at-least-once replay safety and monotonic cursor advancement before
 * publication (canonical d606aab).
 */
export type SettlementKeySource =
  | { readonly kind: 'none' }
  | { readonly kind: 'protocol' }
  | { readonly kind: 'input-field'; readonly path: string }
  | { readonly kind: 'composite'; readonly parts: readonly string[] }
  | { readonly kind: 'host-resolved'; readonly description: string };

export interface WireMethodRow {
  /** Reserved production method name (never a fixture verb). */
  readonly method: string;
  readonly direction: WireDirection;
  readonly grant: WireGrant;
  /** Named request/result carriers (schema anchors for the generator). */
  readonly input: string;
  readonly result: string;
  readonly settlementKeySource: SettlementKeySource;
  /**
   * Reservation-only lifecycle (D0 = A): literal `false` until the
   * publication-readiness proofs pass via a reviewed delta.
   */
  readonly ready: false;
}

export const WIRE_METHOD_REGISTRY: readonly WireMethodRow[] = [
  {
    method: 'broker.hello',
    direction: 'plugin_to_host',
    grant: 'protocol-intrinsic',
    input: 'CandidateHello',
    result: 'SessionBinding',
    settlementKeySource: { kind: 'protocol' },
    ready: false,
  },
  {
    method: 'broker.ready',
    direction: 'plugin_to_host',
    grant: 'protocol-intrinsic',
    input: 'BrokerReadyParams', // { bindingNonce } only — activation-only carrier
    result: 'Null',
    settlementKeySource: { kind: 'protocol' },
    ready: false,
  },
  {
    method: 'messaging.send',
    direction: 'plugin_to_host',
    grant: 'messaging.send',
    input: 'MessageDraft',
    result: 'SendReceiptWithHandle', // frozen SendReceipt + messageHandle (beta.3 delta)
    settlementKeySource: { kind: 'input-field', path: 'input.idempotencyKey' },
    ready: false,
  },
  {
    method: 'messaging.appendElements',
    direction: 'plugin_to_host',
    grant: 'messaging.appendElements',
    input: 'AppendElementsRequest',
    result: 'AppendReceipt',
    settlementKeySource: {
      kind: 'composite',
      parts: ['host-resolved messageId from input.handle', 'input.operationId'],
    },
    ready: false,
  },
  {
    method: 'messaging.subscribe',
    direction: 'plugin_to_host',
    grant: 'message.event.subscribe',
    input: 'MessageHandle',
    result: 'SubscriptionId',
    settlementKeySource: {
      kind: 'host-resolved',
      description: 'input.handle identity (K-1 create-or-get authoritative)',
    },
    ready: false,
  },
  {
    method: 'messaging.read',
    direction: 'plugin_to_host',
    grant: 'message.event.subscribe',
    input: 'SubscriptionReadPageRequest',
    result: 'BoundedSubscriptionReadPageResponse', // normal | empty | stale (frozen discrimination)
    settlementKeySource: { kind: 'none' },
    ready: false,
  },
  {
    method: 'messaging.ack',
    direction: 'plugin_to_host',
    grant: 'message.event.subscribe',
    input: 'MessagingAckRequest', // closed { subscriptionId 1..128, ackToken 1..512 }; Host-resolved token kind
    result: 'Null',
    settlementKeySource: {
      kind: 'composite',
      parts: ['input.subscriptionId', 'input.ackToken'],
    },
    ready: false,
  },
  {
    method: 'messaging.snapshot',
    direction: 'plugin_to_host',
    grant: 'message.event.subscribe',
    input: 'SnapshotPageRequest',
    result: 'SnapshotPageResponse', // intermediate | final (presence discrimination)
    settlementKeySource: { kind: 'none' },
    ready: false,
  },
  {
    method: 'host.messaging.deliver',
    direction: 'host_to_plugin',
    grant: 'onMessage',
    input: 'HostMessagingDeliverRequest', // { deliveryId 1..128, threadHandle: ThreadHandleAddress, envelope: BoundedMessageEnvelope }
    result: 'DeliveryIdAck', // byte-equal echo of params.input.deliveryId
    settlementKeySource: { kind: 'input-field', path: 'input.deliveryId' },
    ready: false,
  },
  {
    method: 'host.grants.changed',
    direction: 'host_to_plugin',
    grant: 'protocol-intrinsic',
    input: 'GrantSnapshot', // notification params; grantRevision monotonic
    result: 'Notification',
    settlementKeySource: { kind: 'protocol' },
    ready: false,
  },
  {
    method: 'host.lifecycle.ping',
    direction: 'host_to_plugin',
    grant: 'protocol-intrinsic',
    input: 'PingNonce', // string 1..512 (contract-minted)
    result: 'PingNonce',
    settlementKeySource: { kind: 'protocol' },
    ready: false,
  },
  {
    method: 'host.lifecycle.drain',
    direction: 'host_to_plugin',
    grant: 'protocol-intrinsic',
    input: 'DrainDeadline', // deadlineUnixMs
    result: 'Null',
    settlementKeySource: { kind: 'protocol' },
    ready: false,
  },
];
