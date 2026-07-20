/**
 * Wire envelope family — closed outer JSON-RPC structures.
 * Mechanized from #1165 R23/R24/R26.
 *
 * The outer envelope family is closed (additionalProperties: false):
 *   - WireRequest:                  id + method + params (request/response)
 *   - WireNotification:             method + params, no id (row 10 only in v0)
 *   - WireSuccessResponse:          id + result, no error
 *   - WireApplicationErrorResponse: id + error (with data)
 *   - WireStandardErrorResponse:    id|null + error (no data)
 *
 * Result/error mutual exclusivity is structural — a response carries
 * exactly one of result or error, never both, never neither.
 *
 * This module defines nothing new — every shape traces to a frozen
 * #1165 revision.
 */

import type { RequestId } from './request-id.js';

// ---------------------------------------------------------------------------
// CallMeta (CLOSED, v0)
// ---------------------------------------------------------------------------

/**
 * Call metadata carried in every request's `params.meta`.
 * Closed surface — v0 defines exactly one field.
 *
 * additionalProperties: false — no members beyond deadlineUnixMs.
 */
export interface CallMeta {
  /**
   * Host-capped absolute deadline.
   * WireUInt53(1, 9_007_199_254_740_991) — zero is forbidden.
   *
   * The Host sets this ceiling; plugins observe it.
   * Must be a positive safe integer (never 0, never negative).
   */
  readonly deadlineUnixMs: number;
}

// ---------------------------------------------------------------------------
// WireRequest (generic, parameterized by method + input)
// ---------------------------------------------------------------------------

/**
 * Generic JSON-RPC request envelope.
 *
 * An object carrying an `id` is a Request — the peer MUST respond.
 * Parameterized by method name M and input shape I.
 *
 * additionalProperties: false — no members beyond jsonrpc, id, method, params.
 */
export interface WireRequest<M extends string = string, I = unknown> {
  readonly jsonrpc: '2.0';
  /** Validated RequestId — byte-equal echo expected in the response. */
  readonly id: RequestId;
  readonly method: M;
  readonly params: {
    readonly meta: CallMeta;
    readonly input: I;
  };
}

// ---------------------------------------------------------------------------
// WireNotification (generic, no id)
// ---------------------------------------------------------------------------

/**
 * Generic JSON-RPC notification envelope (no `id`).
 *
 * In v0, only row 10 (host.grants.changed) is a legal notification.
 * An object without `id` is a notification — no response may be sent.
 *
 * additionalProperties: false — no members beyond jsonrpc, method, params.
 */
export interface WireNotification<M extends string = string, I = unknown> {
  readonly jsonrpc: '2.0';
  readonly method: M;
  readonly params: {
    readonly meta: CallMeta;
    readonly input: I;
  };
}

// ---------------------------------------------------------------------------
// WireSuccessResponse (generic, parameterized by result)
// ---------------------------------------------------------------------------

/**
 * Generic JSON-RPC success response envelope.
 *
 * Carries `result`, never `error`. Mutual exclusivity is structural.
 * additionalProperties: false — no members beyond jsonrpc, id, result.
 */
export interface WireSuccessResponse<R = unknown> {
  readonly jsonrpc: '2.0';
  /** Byte-equal echo of the originating request's id. */
  readonly id: RequestId;
  readonly result: R;
}

// ---------------------------------------------------------------------------
// WireApplicationErrorResponse (generic, with data)
// ---------------------------------------------------------------------------

/**
 * JSON-RPC error response — application variant (with typed `data`).
 *
 * Application errors (-32090 through -32094) carry a `data` field
 * with domain-specific payload. See errors.ts for the 5 concrete
 * application error shapes.
 *
 * The `result` member is forbidden (structural mutual exclusivity).
 * additionalProperties: false.
 */
export interface WireApplicationErrorResponse<D = unknown> {
  readonly jsonrpc: '2.0';
  /** Byte-equal echo of the originating request's id. */
  readonly id: RequestId;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data: D;
  };
}

// ---------------------------------------------------------------------------
// WireStandardErrorResponse (no data)
// ---------------------------------------------------------------------------

/**
 * JSON-RPC error response — standard variant (no `data` field).
 *
 * Standard errors (-32700, -32600, -32601, -32602, -32603) never carry
 * `data`. See errors.ts for the 6 concrete standard error variants.
 *
 * The id field is `RequestId | null`:
 *   - null occurs only for Parse error (-32700) and Invalid Request
 *     (-32600) when no valid id could be extracted from the frame.
 *   - All other standard errors echo the originating request's id.
 *
 * The `result` member is forbidden (structural mutual exclusivity).
 * additionalProperties: false.
 */
export interface WireStandardErrorResponse {
  readonly jsonrpc: '2.0';
  /** RequestId echo, or null for Parse error / Invalid Request no-id arm. */
  readonly id: RequestId | null;
  readonly error: {
    readonly code: number;
    readonly message: string;
  };
}

// ---------------------------------------------------------------------------
// Union types
// ---------------------------------------------------------------------------

/**
 * Either error variant — application (with data) or standard (no data).
 * Both variants forbid `result` and additional members.
 */
export type WireErrorResponse = WireApplicationErrorResponse | WireStandardErrorResponse;

/**
 * Any JSON-RPC response — success or error, never both.
 * Discriminated at runtime by the presence of `result` vs `error`.
 */
export type WireResponse = WireSuccessResponse | WireErrorResponse;
