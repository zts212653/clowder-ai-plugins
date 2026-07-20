/**
 * Pre-dispatch disposition table -- T-A through T-L.
 * Mechanized verbatim from #1165 R35/R39/R44.
 *
 * Every raw-frame/profile/request rejection class has exactly one
 * deterministic transport disposition. The table is frozen: adding
 * or reordering rows requires a contract revision.
 *
 * Three outcome classes:
 *   - close:   connection is torn down, no error response emitted.
 *   - respond: an error response is emitted (standard or application).
 *   - accept:  frame is valid, dispatched or settled, no error response.
 *
 * Derived subsets (exported):
 *   - CLOSE_CLASSES:   close with no response (T-A, T-C, T-E, T-H, T-I, T-K).
 *   - RESPOND_CLASSES: respond with an error  (T-B, T-D, T-F, T-G).
 *   - ACCEPT_CLASSES:  accept and process     (T-J, T-L).
 *
 * These subsets are used in byte-proof exclusion: close/accept classes
 * are excluded from error byte proofs because they never emit an error
 * response onto the wire.
 */

// ---------------------------------------------------------------------------
// Disposition class enum
// ---------------------------------------------------------------------------

/**
 * The 12 pre-dispatch disposition classes, T-A through T-L.
 * Mechanized from #1165 R35.
 */
export const DISPOSITION_CLASSES = [
  'T-A', 'T-B', 'T-C', 'T-D', 'T-E', 'T-F',
  'T-G', 'T-H', 'T-I', 'T-J', 'T-K', 'T-L',
] as const;

/** Union of all disposition class identifiers. */
export type DispositionClass = (typeof DISPOSITION_CLASSES)[number];

// ---------------------------------------------------------------------------
// Outcome types
// ---------------------------------------------------------------------------

/**
 * The three possible transport outcomes for a pre-dispatch rejection.
 *   - close:   tear down the connection, emit nothing.
 *   - respond: emit an error response frame.
 *   - accept:  frame is valid, pass to dispatch/settlement.
 */
export type DispositionOutcome = 'close' | 'respond' | 'accept';

// ---------------------------------------------------------------------------
// Entry shape
// ---------------------------------------------------------------------------

/**
 * A single row of the disposition table.
 *
 * @property class          - The disposition class identifier (T-A .. T-L).
 * @property outcome        - Transport outcome: close, respond, or accept.
 * @property emitsResponse  - Whether an error response is written to the wire.
 * @property dispatches     - Whether the frame reaches the dispatch layer.
 * @property description    - Human-readable description from #1165.
 */
export interface DispositionEntry {
  readonly class: DispositionClass;
  readonly outcome: DispositionOutcome;
  readonly emitsResponse: boolean;
  readonly dispatches: boolean;
  readonly description: string;
}

// ---------------------------------------------------------------------------
// The frozen table (R35/R39/R44)
// ---------------------------------------------------------------------------

/**
 * The complete pre-dispatch disposition table.
 * Every row is mechanized from #1165 R35/R39/R44 -- no interpretation.
 *
 * | #   | Rejection class                                        | Disposition                       |
 * |-----|--------------------------------------------------------|-----------------------------------|
 * | T-A | transport/framing failure                              | close, no response                |
 * | T-B | JSON parse error                                       | respond Parse error, id: null     |
 * | T-C | frame-canonicality failure                              | close, no response                |
 * | T-D | canonical idless non-response-candidate non-Request     | respond Invalid Request, id: null |
 * | T-E | detected but profile-invalid id                        | close, no response                |
 * | T-F | valid id, envelope violation                            | respond standard error, id echoed |
 * | T-G | valid id Request, value violation                       | respond error, id echoed          |
 * | T-H | response candidate validation/correlation failure       | close, no response                |
 * | T-I | in-flight id collision                                  | close, no response                |
 * | T-J | legal Notification (row 10)                             | accept, dispatch, no response     |
 * | T-K | valid Notification, v0 violation                        | close, no response, zero dispatch |
 * | T-L | valid correlated response                               | accept, settle, no response       |
 */
export const DISPOSITION_TABLE: Record<DispositionClass, DispositionEntry> = {
  'T-A': {
    class: 'T-A',
    outcome: 'close',
    emitsResponse: false,
    dispatches: false,
    description: 'transport/framing failure',
  },
  'T-B': {
    class: 'T-B',
    outcome: 'respond',
    emitsResponse: true,
    dispatches: false,
    description: 'JSON parse error',
  },
  'T-C': {
    class: 'T-C',
    outcome: 'close',
    emitsResponse: false,
    dispatches: false,
    description: 'frame-canonicality failure',
  },
  'T-D': {
    class: 'T-D',
    outcome: 'respond',
    emitsResponse: true,
    dispatches: false,
    description: 'canonical idless non-response-candidate non-Request',
  },
  'T-E': {
    class: 'T-E',
    outcome: 'close',
    emitsResponse: false,
    dispatches: false,
    description: 'detected but profile-invalid id',
  },
  'T-F': {
    class: 'T-F',
    outcome: 'respond',
    emitsResponse: true,
    dispatches: false,
    description: 'valid id, envelope violation',
  },
  'T-G': {
    class: 'T-G',
    outcome: 'respond',
    emitsResponse: true,
    dispatches: false,
    description: 'valid id Request, value violation',
  },
  'T-H': {
    class: 'T-H',
    outcome: 'close',
    emitsResponse: false,
    dispatches: false,
    description: 'response candidate validation/correlation failure',
  },
  'T-I': {
    class: 'T-I',
    outcome: 'close',
    emitsResponse: false,
    dispatches: false,
    description: 'in-flight id collision',
  },
  'T-J': {
    class: 'T-J',
    outcome: 'accept',
    emitsResponse: false,
    dispatches: true,
    description: 'legal Notification (row 10)',
  },
  'T-K': {
    class: 'T-K',
    outcome: 'close',
    emitsResponse: false,
    dispatches: false,
    description: 'valid Notification, v0 violation',
  },
  'T-L': {
    class: 'T-L',
    outcome: 'accept',
    emitsResponse: false,
    dispatches: false,
    description: 'valid correlated response',
  },
} as const;

// ---------------------------------------------------------------------------
// Derived subsets for byte-proof exclusion
// ---------------------------------------------------------------------------

/**
 * Disposition classes that close the connection with no response.
 * These are excluded from error byte proofs (no error frame emitted).
 * Mechanized from #1165 R35/R44.
 */
export const CLOSE_CLASSES: readonly DispositionClass[] = [
  'T-A', 'T-C', 'T-E', 'T-H', 'T-I', 'T-K',
] as const;

/**
 * Disposition classes that emit an error response.
 * These are the only classes that produce error frames on the wire.
 * Mechanized from #1165 R35/R39.
 */
export const RESPOND_CLASSES: readonly DispositionClass[] = [
  'T-B', 'T-D', 'T-F', 'T-G',
] as const;

/**
 * Disposition classes that accept the frame for dispatch or settlement.
 * These are excluded from error byte proofs (no error frame emitted).
 * Mechanized from #1165 R35.
 */
export const ACCEPT_CLASSES: readonly DispositionClass[] = [
  'T-J', 'T-L',
] as const;
