/**
 * Messaging domain types — derived from proposal §3.1.
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
  MessageHandle,
  Provenance,
  SubscriptionCursor,
} from './common.js';

// ---------------------------------------------------------------------------
// MessagePayload — content model shared by Draft & Envelope (§3.1)
// ---------------------------------------------------------------------------

/**
 * A single content element within a message.
 *
 * `derivedFromElementId` traces provenance: an augmentation element points
 * back to the element it enriches.  The host enforces that derived elements
 * inherit the epistemic status ceiling of their source — no laundering (P10).
 */
export interface MessageElement {
  readonly elementId: string;
  /** Extensible element kind (text, image, audio, card, …). */
  readonly kind: string;
  /** Kind-specific payload — schema varies by `kind`. */
  readonly payload: unknown;
  /**
   * Points to the stable elementId this element derives from.
   * Host validates existence and enforces epistemicStatus ceiling.
   */
  readonly derivedFromElementId?: string;
}

/**
 * Content model shared by MessageDraft and MessageEnvelope.
 * Provenance is carried at payload level — both draft and canonical share it.
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
 * allowlist).  They CANNOT declare `system` — that is host-only (§3.1).
 */
export type DraftAudience =
  | 'public'
  | { readonly whisper: { readonly targets: readonly string[] } };

/**
 * A message draft submitted by a plugin via `messaging.send(draft)`.
 *
 * Addressing uses host-signed handles only — no raw threadId channel exists
 * at the schema level.
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
  /** RFC 3339 UTC timestamp — timezone is a display concern. */
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
 * - `eventId`: host-assigned, globally unique
 * - `sequence`: per-thread monotonic (host-assigned)
 * - Cursor is opaque, subscription-local — NOT equal to sequence (§3.1)
 */
export interface MessageOutputEvent {
  readonly eventId: string;
  /** Per-thread monotonic sequence number (host-assigned). */
  readonly sequence: number;
  readonly event: MessagePublishEvent | MessageElementsAppendEvent;
}

// ---------------------------------------------------------------------------
// Send receipt
// ---------------------------------------------------------------------------

/**
 * Receipt returned by `messaging.send(draft)`.
 * Same idempotencyKey on retry returns the same receipt.
 */
export interface SendReceipt {
  readonly messageId: string;
  readonly idempotencyKey: string;
}

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
  /** Elements to append — must be non-empty. */
  readonly elements: readonly MessageElement[];
}

// ---------------------------------------------------------------------------
// SubscriptionDelivery — durable ack delivery wrapper (§3.1)
// ---------------------------------------------------------------------------

/**
 * Delivery wrapper for subscription-based event consumption.
 *
 * Carries the opaque SubscriptionCursor alongside a batch of output events.
 * The subscriber acks the cursor (NOT the sequence number) for durable
 * delivery — the host resumes from the acked cursor position after restart.
 *
 * This is the contract-level delivery shape; the kernel defines the
 * transport encoding (HTTP SSE, WebSocket frame, IPC message, etc.).
 */
export interface SubscriptionDelivery {
  /** Opaque cursor for this delivery batch — ack this, not sequence. */
  readonly cursor: SubscriptionCursor;
  /** Batch of output events delivered in this subscription tick. */
  readonly events: readonly MessageOutputEvent[];
}
