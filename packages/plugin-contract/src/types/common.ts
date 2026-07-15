/**
 * Shared primitives for the Clowder AI plugin contract.
 *
 * These types are the TypeScript projection of structures defined in the
 * merged v0 proposal (189f25d §3.1).  The JSON Schema files in ../schemas/
 * are the canonical machine-readable truth source; these types MUST stay
 * aligned — any drift is a P15 violation.
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// Actor & Provenance (§3.1 MessageEnvelope)
// ---------------------------------------------------------------------------

/** Actor kinds — who produced a message or event. */
export type ActorKind = 'user' | 'cat' | 'plugin' | 'device' | 'system';

/**
 * Identity of the entity that produced an artifact.
 * Host binds this at ingress — plugins supply candidates, never authority.
 */
export interface Actor {
  readonly kind: ActorKind;
  readonly id: string;
}

/**
 * Two-axis provenance (§3.1, P10).
 *
 * `origin` = who produced it; `epistemicStatus` = what kind of knowledge it
 * represents.  An `inference` can NEVER be promoted to `user_intent` by a
 * plugin (§3.2a, P10 "推断不执行").
 */
export interface Provenance {
  readonly origin: ActorKind;
  readonly epistemicStatus: EpistemicStatus;
}

/** Epistemic status of a piece of content or event. */
export type EpistemicStatus = 'observation' | 'inference' | 'user_intent';

// ---------------------------------------------------------------------------
// Opaque host-signed handles (§3.1 MessageDraft)
// ---------------------------------------------------------------------------

/**
 * Host-signed thread handle — the ONLY way a plugin can address a thread.
 * Schema-level: there is no "raw threadId" channel (§3.1).
 */
export interface ThreadHandle {
  readonly kind: 'thread';
  /** Opaque token signed by the host; plugins must not parse or forge. */
  readonly token: string;
}

/**
 * Host-signed connector binding reference.
 * Binds (pluginInstance + grant + scope) — not a raw connector ID.
 */
export interface ConnectorBindingRef {
  readonly kind: 'connector-binding';
  /** Opaque token signed by the host. */
  readonly token: string;
}

/** Union of valid addressing targets for a MessageDraft. */
export type DraftAddress = ThreadHandle | ConnectorBindingRef;

// ---------------------------------------------------------------------------
// Idempotency & settlement (§3.1 幂等分层)
// ---------------------------------------------------------------------------

/**
 * Send idempotency key scope: (pluginInstanceId, idempotencyKey).
 * Cross-instance keys never collide; reinstalled instances don't reuse.
 */
export interface SendIdempotencyScope {
  readonly pluginInstanceId: string;
  readonly idempotencyKey: string;
}

/**
 * Append idempotency key scope: (pluginInstanceId, messageId, operationId).
 */
export interface AppendIdempotencyScope {
  readonly pluginInstanceId: string;
  readonly messageId: string;
  readonly operationId: string;
}

// ---------------------------------------------------------------------------
// MessageHandle — opaque append authorization (§3.3, G-0 件 2 注 2)
// ---------------------------------------------------------------------------

/**
 * Host-signed message handle — authorization token for `appendElements`.
 *
 * Delivered to a plugin via subscription (onEvent) or callback (onMessage).
 * Possessing a MessageHandle does NOT bypass L2 content-read authorization;
 * it only authorizes the publish channel for augmentation (G-0 件 2 注 2).
 *
 * Shape finalized by K-1; this is the contract-level type shell.
 */
export interface MessageHandle {
  readonly kind: 'message';
  /** Opaque token signed by the host; plugins must not parse or forge. */
  readonly token: string;
}

// ---------------------------------------------------------------------------
// Subscription cursor — opaque, subscription-local (§3.1)
// ---------------------------------------------------------------------------

/**
 * Opaque subscription cursor for durable ack-based delivery.
 *
 * NOT equal to sequence number (§3.1 明示).  Each cursor is scoped to
 * (pluginInstanceId × subscription).  The host persists ack position and
 * resumes from cursor after restart.
 */
export interface SubscriptionCursor {
  readonly kind: 'subscription-cursor';
  /** Opaque token — subscription-local, not cross-thread. */
  readonly token: string;
}

// ---------------------------------------------------------------------------
// Ingress source address — connector binding (§3.1)
// ---------------------------------------------------------------------------

/**
 * External ingress source address, carried before canonical binding.
 *
 * The Host Adapter uses this to resolve the target thread and bind
 * actor/provenance before generating a canonical MessageEnvelope.
 */
export interface IngressSourceAddress {
  readonly connectorId: string;
  readonly chatId: string;
  readonly messageId?: string;
}
