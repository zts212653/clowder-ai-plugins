/**
 * Type-level regression probes (RED tests) for Q1 closed-world ruling.
 *
 * Every `@ts-expect-error` line MUST fire during `tsc --noEmit`. If any
 * probe stops firing (the directive becomes "unused"), it means an
 * open-world type leaked back into the public barrel — a regression.
 *
 * Three probe families:
 *   (a) Generic envelope constructors NOT in public barrel
 *   (b) RESERVED row inputs are `never` — no value satisfies
 *   (c) Error response beyond 11 closed arms cannot be constructed
 *
 * This file is excluded from tsconfig.build.json (production build) but
 * included in tsconfig.json (typecheck). It emits no runtime code.
 */

import type {
  // Closed types that SHOULD be in the barrel
  WireErrorResponse,
  WireMethodName,
  RequestId,
  // RESERVED row input stubs (all = never)
  HelloInput,
  ReadyInput,
  SendInput,
  AppendInput,
  ReadInput,
  SnapshotInput,
  DeliverInput,
} from './index.js';

// ═══════════════════════════════════════════════════════════════════════════
// RED (a): Generic envelope constructors are NOT in the public barrel.
//
// WireRequest<M, I>, WireNotification<M, I>, WireApplicationErrorResponse<D>,
// and WireStandardErrorResponse are internal building blocks in envelope.ts.
// They must NOT be re-exported from the barrel (index.ts).
//
// If any of these probes becomes "unused @ts-expect-error", someone
// accidentally re-exported a generic — revert the export.
// ═══════════════════════════════════════════════════════════════════════════

// @ts-expect-error — WireRequest not in public barrel (Q1 closed-world)
type _OpenReq = import('./index.js').WireRequest;

// @ts-expect-error — WireNotification not in public barrel (Q1 closed-world)
type _OpenNotif = import('./index.js').WireNotification;

// @ts-expect-error — WireApplicationErrorResponse not in public barrel (Q1)
type _OpenAppErr = import('./index.js').WireApplicationErrorResponse;

// @ts-expect-error — WireStandardErrorResponse not in public barrel (Q1)
type _OpenStdErr = import('./index.js').WireStandardErrorResponse;

// ═══════════════════════════════════════════════════════════════════════════
// RED (b): RESERVED row inputs are `never` — no concrete value satisfies.
//
// Rows 1-4, 6, 8-9 are RESERVED. Their input types are `never`, which
// means no code can construct or consume these shapes until the row's
// matrix entries close. Assigning any value to `never` is a type error.
// ═══════════════════════════════════════════════════════════════════════════

// @ts-expect-error — Row 1 (broker.hello) input is never
const _reservedHello: HelloInput = '';

// @ts-expect-error — Row 2 (broker.ready) input is never
const _reservedReady: ReadyInput = '';

// @ts-expect-error — Row 3 (messaging.send) input is never
const _reservedSend: SendInput = '';

// @ts-expect-error — Row 4 (messaging.appendElements) input is never
const _reservedAppend: AppendInput = '';

// @ts-expect-error — Row 6 (messaging.read) input is never
const _reservedRead: ReadInput = '';

// @ts-expect-error — Row 8 (messaging.snapshot) input is never
const _reservedSnapshot: SnapshotInput = '';

// @ts-expect-error — Row 9 (host.messaging.deliver) input is never
const _reservedDeliver: DeliverInput = '';

// ═══════════════════════════════════════════════════════════════════════════
// RED (c): Error responses beyond the 11 closed arms cannot be constructed.
//
// WireErrorResponse = ClosedWireErrorResponse (the 11-arm union). A custom
// error envelope with a code not in the closed set (-32090..-32094,
// -32700, -32600..-32603) must NOT be assignable to WireErrorResponse.
//
// The error body types use literal `typeof` code types (e.g. code: -32090),
// so a custom code like -32000 is structurally incompatible with every arm.
//
// We use `declare const` to create typed values without runtime code, then
// test assignability to WireErrorResponse on a single line so that the
// expect-error directive captures the type mismatch correctly.
// ═══════════════════════════════════════════════════════════════════════════

// Custom error with id and non-closed code
declare const _fakeErrorWithId: {
  readonly jsonrpc: '2.0';
  readonly id: RequestId;
  readonly error: { readonly code: -32000; readonly message: 'custom' };
};
// @ts-expect-error — code -32000 not in any of the 11 closed error arms
const _probeC1: WireErrorResponse = _fakeErrorWithId;

// Custom error with null id and non-closed code
declare const _fakeErrorNullId: {
  readonly jsonrpc: '2.0';
  readonly id: null;
  readonly error: { readonly code: -32999; readonly message: 'made up' };
};
// @ts-expect-error — code -32999 not in any of the 11 closed error arms
const _probeC2: WireErrorResponse = _fakeErrorNullId;

// ═══════════════════════════════════════════════════════════════════════════
// RED (method): Unknown method string is not a WireMethodName.
//
// The 12-row registry defines a closed set of method names. A string
// not in that set must not be assignable to WireMethodName.
// ═══════════════════════════════════════════════════════════════════════════

// @ts-expect-error — 'not.a.method' is not in the 12-row closed method enum
const _badMethod: WireMethodName = 'not.a.method';
