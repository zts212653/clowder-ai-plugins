/**
 * Contract-mirror constants — runtime key sets and enum values that
 * mirror @clowder-ai/plugin-contract TypeScript interfaces and types.
 *
 * These exist because the contract expresses certain closed constraints
 * (additionalProperties: false, enum unions) only at the type level,
 * with no runtime array/set export.
 *
 * ## DELETION TARGET
 *
 * Every constant in this module is scheduled for deletion when the
 * contract exports a runtime equivalent (beta.5 delta scope, Fable
 * ruling on S1 R3 contract seam). Each constant documents which
 * contract source it mirrors.
 *
 * ## Drift prevention
 *
 * contract-mirror.test.ts verifies each constant against the contract
 * source (schema JSON enum where available, structural assertions
 * against contract types elsewhere). Drift = CI red.
 *
 * Pattern precedent: #10 MAX_FRAME_BYTES alias + drift test → Fable
 * ruling 1 (fixtures test-only import) → this ruling (systematic).
 */

// ═══════════════════════════════════════════════════════════════════════════
// Enum mirrors — contract has type-only unions, no runtime arrays
// ═══════════════════════════════════════════════════════════════════════════

/**
 * MessagingErrorCode runtime values.
 *
 * Mirror of: messaging.schema.json → definitions.MessagingErrorCode.enum
 * Contract type: MessagingErrorCode (contract.generated.ts:217)
 * Drift test: automated, vs schema JSON enum (exact member + order match)
 */
export const MESSAGING_ERROR_CODES = [
  'VALIDATION',
  'PERMISSION',
  'NOT_FOUND',
  'CONFLICT',
  'RETRYABLE_INFLIGHT',
  'STALE_CURSOR',
] as const;

export const MESSAGING_ERROR_CODE_SET = new Set<string>(MESSAGING_ERROR_CODES);

// ═══════════════════════════════════════════════════════════════════════════
// Envelope outer key sets (additionalProperties: false)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Mirror of: WireSuccessResponse interface (envelope.ts:108-113)
 * Keys: jsonrpc, id, result — additionalProperties: false
 */
export const RESPONSE_SUCCESS_KEYS = new Set(['jsonrpc', 'id', 'result']);

/**
 * Mirror of: WireApplicationErrorResponse / WireStandardErrorResponse
 * (envelope.ts:129-166). Keys: jsonrpc, id, error — additionalProperties: false
 */
export const RESPONSE_ERROR_KEYS = new Set(['jsonrpc', 'id', 'error']);

/**
 * Mirror of: WireNotification interface (envelope.ts:89-96)
 * Keys: jsonrpc, method, params — additionalProperties: false
 */
export const NOTIFICATION_ALLOWED_KEYS = new Set(['jsonrpc', 'method', 'params']);

/**
 * Mirror of: WireRequest interface (envelope.ts:66-75)
 * Keys: jsonrpc, id, method, params — additionalProperties: false
 */
export const REQUEST_ALLOWED_KEYS = new Set(['jsonrpc', 'id', 'method', 'params']);

// ═══════════════════════════════════════════════════════════════════════════
// Params / meta key sets (closed nested objects)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Mirror of: WireRequest.params / WireNotification.params (envelope.ts:71-74, 93-95)
 * Keys: meta, input — additionalProperties: false
 */
export const PARAMS_ALLOWED_KEYS = new Set(['meta', 'input']);

/**
 * Mirror of: CallMeta interface (envelope.ts:43-52)
 * Keys: deadlineUnixMs — additionalProperties: false, v0 single field
 */
export const META_ALLOWED_KEYS = new Set(['deadlineUnixMs']);

// ═══════════════════════════════════════════════════════════════════════════
// Per-method CLOSED-row input key sets (additionalProperties: false)
// ═══════════════════════════════════════════════════════════════════════════

/** Mirror of: PingInput (row-shapes.ts:144-147). Keys: {nonce} */
export const PING_INPUT_KEYS = new Set(['nonce']);

/** Mirror of: DrainInput (row-shapes.ts:183-193). Keys: {deadlineUnixMs} */
export const DRAIN_INPUT_KEYS = new Set(['deadlineUnixMs']);

/** Mirror of: SubscribeInput (row-shapes.ts:27-30). Keys: {handle} */
export const SUBSCRIBE_INPUT_KEYS = new Set(['handle']);

/** Mirror of: MessagingAckRequest (row-shapes.ts:76-81). Keys: {subscriptionId, ackToken} */
export const ACK_INPUT_KEYS = new Set(['subscriptionId', 'ackToken']);

/** Mirror of: GrantsChangedInput = GrantSnapshot (row-shapes.ts:128, grants.ts). Keys: {grantRevision, effectiveGrants} */
export const GRANTS_CHANGED_INPUT_KEYS = new Set(['grantRevision', 'effectiveGrants']);

// ═══════════════════════════════════════════════════════════════════════════
// Handshake object key sets (type-only structural contract)
// ═══════════════════════════════════════════════════════════════════════════

/** Mirror of: CandidateHello (handshake.ts:62-71). */
export const CANDIDATE_HELLO_KEYS = new Set([
  'pluginId',
  'packageDigest',
  'contractVersion',
  'wireVersion',
]);

/** Mirror of: SessionBinding (handshake.ts:82-101). */
export const SESSION_BINDING_KEYS = new Set([
  'pluginId',
  'packageDigest',
  'contractVersion',
  'wireVersion',
  'pluginInstanceId',
  'brokerSessionId',
  'grantRevision',
  'effectiveGrants',
  'bindingNonce',
]);

/** Mirror of: BrokerReadyParams (handshake.ts:113-116). */
export const BROKER_READY_PARAMS_KEYS = new Set(['bindingNonce']);

// ═══════════════════════════════════════════════════════════════════════════
// Per-method CLOSED-row result key sets (additionalProperties: false)
// ═══════════════════════════════════════════════════════════════════════════

/** Mirror of: PingResult (row-shapes.ts:152-158). Keys: {nonce} */
export const PING_RESULT_KEYS = new Set(['nonce']);

/** Mirror of: SubscribeResult (row-shapes.ts:35-39). Keys: {subscriptionId} */
export const SUBSCRIBE_RESULT_KEYS = new Set(['subscriptionId']);

/**
 * Mirror of: deliver acknowledgement result closed member set.
 * Row 9 (host.messaging.deliver) has a frozen ack result shape
 * {deliveryId: string, length 1..128 code points} — additionalProperties: false.
 *
 * Despite row 9 being RESERVED overall (DeliverResult = never in types),
 * the ack shape is frozen per the #1165 protocol specification. The
 * deliveryId echo is the fundamental delivery acknowledgement mechanism.
 *
 * Maintainer requirement: enforce closed member set + string bounds.
 */
export const DELIVER_RESULT_KEYS = new Set(['deliveryId']);

/** Minimum deliveryId code-point length (frozen row 9 ack shape). */
export const DELIVER_DELIVERY_ID_MIN_LENGTH = 1 as const;

/** Maximum deliveryId code-point length (frozen row 9 ack shape). */
export const DELIVER_DELIVERY_ID_MAX_LENGTH = 128 as const;

// ═══════════════════════════════════════════════════════════════════════════
// Error body key sets (closed per error variant)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Mirror of: StandardWireError body keys (errors.ts:240-299)
 * Standard errors: {code, message} — no data field.
 */
export const ERROR_BODY_STANDARD_KEYS = new Set(['code', 'message']);

/**
 * Mirror of: ApplicationWireError body keys (errors.ts:182-234)
 * Application errors: {code, message, data} — data required.
 */
export const ERROR_BODY_APPLICATION_KEYS = new Set(['code', 'message', 'data']);

// ═══════════════════════════════════════════════════════════════════════════
// Per-arm application error data key sets (additionalProperties: false)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Mirror of: HandshakeRejectedError.data / DeliveryRejectedError.data /
 * SnapshotUnavailableError.data — all {reason: <enum>}
 */
export const REASON_DATA_KEYS = new Set(['reason']);

/**
 * Mirror of: DomainError.data (errors.ts:205-206)
 * Keys: {code: MessagingErrorCode} — additionalProperties: false
 */
export const CODE_DATA_KEYS = new Set(['code']);

// ═══════════════════════════════════════════════════════════════════════════
// NOTE: Constants NOT in this module (derived from contract imports)
// ═══════════════════════════════════════════════════════════════════════════
//
// The following are built from contract-imported arrays, not mirrors:
//   KNOWN_ERROR_CODES = new Set(ALL_ERROR_CODES)         — from contract
//   APPLICATION_CODES = new Set(APPLICATION_ERROR_CODES)  — from contract
//   HANDSHAKE_REASONS = new Set(HANDSHAKE_REJECT_REASONS) — from contract
//   DELIVERY_REASONS  = new Set(DELIVERY_REJECT_REASONS)  — from contract
//   SNAPSHOT_REASONS  = new Set(SNAPSHOT_UNAVAILABLE_REASONS) — from contract
//   NULL_ID_ERROR_CODES = new Set([PARSE_ERROR_CODE])     — from contract
//
// These stay in wire-dispatch.ts as performance wrappers, not mirrors.
