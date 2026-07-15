/**
 * Messaging domain types — derived from proposal §3.1, aligned with
 * K-1 mirror values (9-point candidate alignment).
 *
 * Two artifacts share one content model (MessagePayload):
 * - MessageDraft: what a plugin submits
 * - MessageEnvelope: what the host produces (canonical)
 *
 * Output event stream carries MessageOutputEvent with per-thread monotonic
 * sequence and durable ack cursor.
 *
 * @packageDocumentation
 */

import type {
  Actor,
  DraftAddress,
  EpistemicStatus,
  MessageHandle,
  Provenance,
  SubscriptionCursor,
} from './common.js';

// ---------------------------------------------------------------------------
// ElementKind — v0 content element types (@candidate, K-1 mirror point 3)
// ---------------------------------------------------------------------------

/**
 * @candidate — v0 element kinds.
 * - `text`: requires payload shape `{text: string}`
 * - `media_ref`: reference to external media
 * - `rich_block`: structured content block
 */
export type ElementKind = 'text' | 'media_ref' | 'rich_block';

// ---------------------------------------------------------------------------
// MessageElement — content unit with element-level epistemicStatus
// ---------------------------------------------------------------------------

/**
 * A single content element within a message.
 *
 * @candidate bounds: elementId ≤ 128 chars (K-1 mirror point 4).
 *
 * `derivedFromElementId` traces provenance: an augmentation element points
 * back to the element it enriches.  The host enforces that derived elements
 * inherit the epistemic status ceiling of their source — no laundering (P10).
 *
 * `epistemicStatus` (optional): element-level override. Defaults to `inference`
 * if omitted. Declaring non-inference requires derivedFromElementId pointing
 * to a source with same-or-higher status (INV-7 machine enforcement,
 * K-1 mirror point 8).
 */
export interface MessageElement {
  readonly elementId: string;
  /** @candidate v0 element kind — text | media_ref | rich_block. */
  readonly kind: ElementKind;
  /** Kind-specific payload — shape varies by `kind`. text → {text:string}. */
  readonly payload: unknown;
  /**
   * Points to the stable elementId this element derives from.
   * Host validates existence and enforces epistemicStatus ceiling (INV-7).
   */
  readonly derivedFromElementId?: string;
  /**
   * @candidate — element-level epistemic override.
   * Defaults to 'inference' if omitted. Non-inference requires
   * derivedFromElementId pointing to same-or-higher status source.
   */
  readonly epistemicStatus?: EpistemicStatus;
}

// ---------------------------------------------------------------------------
// MessagePayload — content model shared by Draft & Envelope (§3.1)
// ---------------------------------------------------------------------------

/**
 * Content model shared by MessageDraft and MessageEnvelope.
 * Provenance is carried at payload level — both draft and canonical share it.
 *
 * @candidate bound: max 32 elements per operation (K-1 mirror point 4).
 */
export interface MessagePayload {
  readonly provenance: Provenance;
  readonly elements: readonly MessageElement[];
  readonly correlationId?: string;
  readonly causationId?: string;
}

// ---------------------------------------------------------------------------
// MessageDraft — plugin submits this (§3.1)
// ---------------------------------------------------------------------------

/**
 * Audience as declared by the plugin in a draft.
 *
 * Plugins can request `public` or `whisper` (with targets limited to grant
 * allowlist, @candidate max 16 targets — K-1 mirror point 4).
 * They CANNOT declare `system` — that is host-only (§3.1).
 */
export type DraftAudience =
  | 'public'
  | { readonly whisper: { readonly targets: readonly string[] } };

/**
 * A message draft submitted by a plugin via `messaging.send(draft)`.
 *
 * Addressing uses host-signed handles only — no raw threadId channel exists
 * at the schema level.
 *
 * @candidate bound: idempotencyKey ≤ 200 chars (K-1 mirror point 4).
 */
export interface MessageDraft {
  /** Host-signed addressing handle (ThreadHandle | ConnectorBindingRef). */
  readonly address: DraftAddress;
  /**
   * Requested audience.  Omit for default (public).
   * `system` is structurally impossible here — only the host can produce it.
   */
  readonly draftAudience?: DraftAudience;
  /**
   * Client-generated idempotency key (REQUIRED).
   * Must be stable across retries/restarts.
   * Ledger key = (pluginInstanceId, idempotencyKey).
   */
  readonly idempotencyKey: string;
  /** External source provenance — NOT the idempotency key. */
  readonly sourceEventId?: string;
  /** Reply threading. */
  readonly replyTo?: string;
  /** Message content. */
  readonly payload: MessagePayload;
}

// ---------------------------------------------------------------------------
// MessageEnvelope — canonical, host-produced (§3.1)
// ---------------------------------------------------------------------------

/**
 * Canonical audience on a delivered envelope.
 * `system` can only be produced by the host — never from a plugin draft.
 */
export type CanonicalAudience =
  | 'public'
  | { readonly whisper: { readonly targets: readonly string[] } }
  | 'system';

/**
 * The canonical message produced by the host after accepting a draft.
 *
 * All identity fields (actor, audience, occurredAt) are host-bound — plugin
 * self-reported values are candidates only.
 */
export interface MessageEnvelope {
  readonly messageId: string;
  readonly revision: number;
  readonly threadId: string;
  readonly replyTo?: string;
  /** Host-bound actor identity. */
  readonly actor: Actor;
  /** Host-derived audience; `system` only from host. */
  readonly audience: CanonicalAudience;
  /** RFC 3339 UTC timestamp (must end with 'Z') — timezone is a display concern. */
  readonly occurredAt: string;
  /** Message content (same model as draft). */
  readonly payload: MessagePayload;
}

// ---------------------------------------------------------------------------
// MessageOutputEvent — event stream (§3.1)
// ---------------------------------------------------------------------------

/** A published message event. */
export interface MessagePublishEvent {
  readonly type: 'message.publish';
  readonly envelope: MessageEnvelope;
}

/** An element-append event (atomic augmentation). */
export interface MessageElementsAppendEvent {
  readonly type: 'message.elements.append';
  readonly messageId: string;
  /**
   * Operation ID for append idempotency.
   * Ledger key = (pluginInstanceId, messageId, operationId).
   */
  readonly operationId: string;
  /** Optimistic concurrency — reject if stale. */
  readonly baseRevision?: number;
  readonly elements: readonly MessageElement[];
}

/**
 * An event in the per-thread output event stream.
 *
 * @candidate — eventId is deterministic (K-1 mirror point 9):
 * pattern ev_pub_{msgId}_{revision} / ev_app_{msgId}_{opId}.
 * Enables idempotent event replay.
 *
 * Restricted content does not emit events → sequence may have visible
 * gaps but monotonicity is never broken.
 */
export interface MessageOutputEvent {
  /** @candidate deterministic, globally unique event ID. */
  readonly eventId: string;
  /** Per-thread monotonic sequence number (host-assigned). Gaps possible. */
  readonly sequence: number;
  readonly event: MessagePublishEvent | MessageElementsAppendEvent;
}

// ---------------------------------------------------------------------------
// Receipts (@candidate, K-1 mirror point 6)
// ---------------------------------------------------------------------------

/**
 * @candidate receipt from `messaging.send(draft)`.
 *
 * Whisper messages do NOT carry publishSequence — v0: whisper not in
 * event stream, fail-closed (K-1 mirror point 6).
 */
export interface SendReceipt {
  readonly messageId: string;
  readonly threadId: string;
  readonly revision: number;
  /** Absent for whisper messages (v0: whisper not in event stream). */
  readonly publishSequence?: number;
}

/**
 * @candidate receipt from `messaging.appendElements(request)`.
 */
export interface AppendReceipt {
  readonly messageId: string;
  readonly revision: number;
  /** Per-thread event sequence for the append event. */
  readonly appendSequence?: number;
  /** Element IDs that were actually applied (server may filter duplicates). */
  readonly appliedElementIds: readonly string[];
}

// ---------------------------------------------------------------------------
// Error codes (@candidate, K-1 mirror point 5)
// ---------------------------------------------------------------------------

/**
 * @candidate messaging domain error codes.
 *
 * - VALIDATION: malformed request (schema/bounds violation)
 * - PERMISSION: insufficient capability grants
 * - NOT_FOUND: target thread/message/subscription not found
 * - CONFLICT: optimistic concurrency conflict (baseRevision stale)
 * - RETRYABLE_INFLIGHT: send accepted but settlement pending (retry safe)
 * - STALE_CURSOR: subscription cursor behind event window, need snapshot
 */
export type MessagingErrorCode =
  | 'VALIDATION'
  | 'PERMISSION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RETRYABLE_INFLIGHT'
  | 'STALE_CURSOR';

// ---------------------------------------------------------------------------
// AppendElementsRequest — plugin call to augment an existing message (§3.3)
// ---------------------------------------------------------------------------

/**
 * Request to append elements to an existing message.
 *
 * Requires a MessageHandle (authorization) and at least one MessageElement.
 * Idempotency key = (pluginInstanceId, messageId, operationId).
 * The host rejects if operationId already settled (idempotent replay).
 *
 * P10 ceiling enforced: appended elements inherit the epistemicStatus ceiling
 * of the message they augment.
 */
export interface AppendElementsRequest {
  /** Host-signed message handle — authorization for this append. */
  readonly handle: MessageHandle;
  /**
   * Operation ID for idempotency.
   * Ledger key = (pluginInstanceId, handle.messageId, operationId).
   */
  readonly operationId: string;
  /**
   * Optimistic concurrency guard.
   * If provided, the host rejects when baseRevision < current revision.
   */
  readonly baseRevision?: number;
  /** Elements to append — must be non-empty, @candidate max 32. */
  readonly elements: readonly MessageElement[];
}

// ---------------------------------------------------------------------------
// Subscription protocol (@candidate verb names, K-1 mirror point 7)
// ---------------------------------------------------------------------------

/**
 * @candidate verb name 'read'. Response from subscription read operation.
 *
 * Expresses three states (proposal §3.1):
 * - Normal delivery: events + ackToken (ack to advance cursor)
 * - Empty read: events=[], ackToken=null (no new events)
 * - Stale: stale=true → cursor behind event window, need snapshot
 *
 * Proposal invariant: stale does NOT silently drop events — client
 * must call snapshot to catch up.
 */
export interface SubscriptionReadResponse {
  /** Batch of output events. Empty array = no new events. */
  readonly events: readonly MessageOutputEvent[];
  /** Cursor to ack. null when no events available (empty read). */
  readonly ackToken: SubscriptionCursor | null;
  /** true → cursor behind event window, need snapshot to catch up. */
  readonly stale: boolean;
}

/**
 * @candidate verb name 'snapshot'. Full envelope snapshot for catch-up
 * after stale cursor (§3.1).
 *
 * Provides current thread canonical state and a sequence number to
 * resume subscription from.
 */
export interface SnapshotResponse {
  /** Current thread envelopes (canonical state). */
  readonly envelopes: readonly MessageEnvelope[];
  /** Sequence number to resume subscription from after processing snapshot. */
  readonly resumeSequence: number;
}
