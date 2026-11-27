/**
 * Memory v1 wire contract.
 *
 * This package is the shared truth for the Host↔memory-plugin boundary. It
 * carries DTOs, boundary validation and the descriptor explanation; it holds no
 * implementation and no storage details. Its version moves independently of
 * `@clowder-ai/plugin-contract` and the plugin SDK.
 *
 * @packageDocumentation
 */

/** Wire protocol major. A different major is never compatible. */
export const MEMORY_PROTOCOL_MAJOR = 1;

/** Durable storage format the Host may read and roll back to. */
export const MEMORY_STORAGE_FORMAT = 1;

/** Operations a v1 memory plugin must serve to be admitted. */
export const MEMORY_REQUIRED_OPERATIONS = ['kv.put', 'kv.get', 'kv.list', 'kv.delete'] as const;

/**
 * Operations a plugin may additionally serve.
 *
 * Retrieval is beyond the admission floor on purpose: a Host that never reads
 * the evidence store must not fail admission because this plugin also offers
 * search. The Host still needs the operations list to decide whether a call it
 * intends to make is supported.
 */
export const MEMORY_SEARCH_OPERATIONS = ['search.query'] as const;

export type MemoryOperation = (typeof MEMORY_REQUIRED_OPERATIONS)[number] | (typeof MEMORY_SEARCH_OPERATIONS)[number];

/** What the plugin reports through `memory.describe`; it carries no business parameters. */
export interface MemoryDescriptor {
  readonly protocolMajor: number;
  readonly operations: readonly string[];
  readonly storageFormat: number;
}

/** One stored key in a thread. Field-for-field the Host's existing `MemoryEntry`. */
export interface MemoryEntryDto {
  readonly key: string;
  readonly value: string;
  readonly threadId: string;
  readonly updatedBy: string;
  readonly updatedAt: number;
}

export interface KvPutInput {
  readonly threadRef: string;
  readonly key: string;
  readonly value: string;
  readonly updatedBy: string;
}

export interface KvGetInput {
  readonly threadRef: string;
  readonly key: string;
}

export interface KvListInput {
  readonly threadRef: string;
}

export interface KvDeleteInput {
  readonly threadRef: string;
  readonly key: string;
}

/** Host ceilings for the thread KV family, unchanged from the live route. */
const MAX_THREAD_REF = 100;
const MAX_KEY = 100;
const MAX_VALUE = 10000;
/** Host ceilings for retrieval, unchanged from the live search route. */
const MAX_QUERY = 2000;
const MAX_RESULTS = 20;
/** The live route's ceiling for surrounding passages per raw hit. */
const MAX_CONTEXT_WINDOW = 5;

/** Which data layer a retrieval targets. Mirrors the live route's `scope`. */
export const SEARCH_SCOPES = ['docs', 'memory', 'threads', 'sessions', 'all'] as const;
/** Retrieval mode. `hybrid` is fusion; a plugin may degrade and must say so. */
export const SEARCH_MODES = ['lexical', 'semantic', 'hybrid'] as const;
/** `summary` returns ranked documents; `raw` adds passage detail for the same hits. */
export const SEARCH_DEPTHS = ['summary', 'raw'] as const;

/**
 * Retrieval request.
 *
 * Deliberately narrower than the Host's internal `SearchOptions`: these are the
 * options the live HTTP route and the internal recall consumer actually pass.
 * Anything the caller could use to widen its own reach — authorization grants,
 * cancellations, deadlines — is Host-side and absent here by construction.
 */
export interface SearchOptionsDto {
  readonly limit?: number;
  readonly scope?: (typeof SEARCH_SCOPES)[number];
  readonly mode?: (typeof SEARCH_MODES)[number];
  readonly depth?: (typeof SEARCH_DEPTHS)[number];
  readonly threadId?: string;
  readonly dateFrom?: string;
  readonly dateTo?: string;
  /** Surrounding passages to include per raw hit; absent means the hit's own passages only. */
  readonly contextWindow?: number;
  /**
   * Include candidates reserved for pull surfaces.
   *
   * Host-derived, never caller-derived: ordinary recall leaves it out and thus
   * never sees these rows, while a surface that already established the caller
   * is pulling explicitly asks for them.
   */
  readonly includePullOnly?: boolean;
  /** Include the scoring breakdown on each hit. */
  readonly explain?: boolean;
}

export interface SearchInput {
  readonly query: string;
  readonly options: SearchOptionsDto;
}

/**
 * One passage of a hit's own document, returned when the caller asked for
 * `depth: 'raw'`.
 *
 * Field-for-field the Host's existing `EvidenceItem.passages` entry, so a
 * consumer that already reads the live response keeps working across the
 * plugin boundary.
 */
export interface SearchPassageDto {
  /** The document this passage belongs to; absent when it is the hit's own. */
  readonly docAnchor?: string;
  readonly passageId: string;
  readonly content: string;
  readonly speaker?: string;
  readonly createdAt?: string;
  readonly threadId?: string;
  readonly messageId?: string;
  /** Surrounding passages, present only when the caller asked for a context window. */
  readonly context?: readonly Omit<SearchPassageDto, 'context'>[];
}

/**
 * One ranked retrieval hit.
 *
 * The fields are the ones the live response envelope builds from a store item
 * and both consumers read. Storage internals (pack scope, projection state,
 * contradiction bookkeeping) stay out: the plugin owns them behind this shape.
 */
export interface SearchHitDto {
  readonly anchor: string;
  readonly kind: string;
  readonly title: string;
  readonly snippet: string;
  /** 1-based rank in this result set. */
  readonly rank: number;
  readonly status?: string;
  readonly sourcePath?: string;
  readonly sourceHash?: string;
  readonly updatedAt?: string;
  readonly authority?: string;
  readonly matchReason?: string;
  readonly retrievalScore?: number;
  readonly rankingFactors?: {
    readonly bm25Score?: number;
    readonly consumptionPrior?: number;
    readonly mmrPenalty?: number;
  };
  /**
   * Passage detail for this hit, present only on `depth: 'raw'`.
   *
   * A raw request that returns no passages is a different fact from one that
   * returned them, so the field is absent rather than empty for a non-raw
   * result — an empty array would claim the document has no passages.
   */
  readonly passages?: readonly SearchPassageDto[];
}

export interface SearchResultDto {
  readonly query: string;
  readonly hits: readonly SearchHitDto[];
  /** False when the plugin answered from a degraded path; the Host surfaces this. */
  readonly degraded: boolean;
  readonly degradeReason?: string;
  /** The mode actually executed, which may be narrower than the requested one. */
  readonly effectiveMode?: (typeof SEARCH_MODES)[number];
}

export function memoryDescriptor(): MemoryDescriptor {
  return {
    protocolMajor: MEMORY_PROTOCOL_MAJOR,
    operations: [...MEMORY_REQUIRED_OPERATIONS, ...MEMORY_SEARCH_OPERATIONS],
    storageFormat: MEMORY_STORAGE_FORMAT,
  };
}

/**
 * Admission check: same major, every required operation, and the exact storage
 * format this Host can still open and roll back to.
 */
export function isCompatibleDescriptor(candidate: unknown): candidate is MemoryDescriptor {
  if (!isRecord(candidate)) return false;
  if (candidate.protocolMajor !== MEMORY_PROTOCOL_MAJOR) return false;
  if (candidate.storageFormat !== MEMORY_STORAGE_FORMAT) return false;
  if (!Array.isArray(candidate.operations)) return false;
  const offered = new Set(candidate.operations.filter((value): value is string => typeof value === 'string'));
  return MEMORY_REQUIRED_OPERATIONS.every((operation) => offered.has(operation));
}

/** Human-readable reason a candidate was rejected; used in admission diagnostics. */
export function explainDescriptor(candidate: unknown): string {
  if (!isRecord(candidate)) return 'memory descriptor is missing or not an object';
  if (candidate.protocolMajor !== MEMORY_PROTOCOL_MAJOR) {
    return `memory protocolMajor ${String(candidate.protocolMajor)} is not ${MEMORY_PROTOCOL_MAJOR}`;
  }
  if (!Array.isArray(candidate.operations)) return 'memory descriptor has no operations list';
  const offered = new Set(candidate.operations.filter((value): value is string => typeof value === 'string'));
  const missing = MEMORY_REQUIRED_OPERATIONS.filter((operation) => !offered.has(operation));
  if (missing.length > 0) return `memory plugin is missing required operations: ${missing.join(', ')}`;
  if (candidate.storageFormat !== MEMORY_STORAGE_FORMAT) {
    return `memory storageFormat ${String(candidate.storageFormat)} is not ${MEMORY_STORAGE_FORMAT}`;
  }
  return 'memory descriptor is compatible';
}

export function parseKvPut(value: unknown): KvPutInput {
  const input = requireRecord(value, 'kv.put input');
  expectOnlyFields(input, ['threadRef', 'key', 'value', 'updatedBy']);
  return {
    threadRef: requireBoundedString(input, 'threadRef', MAX_THREAD_REF),
    key: requireBoundedString(input, 'key', MAX_KEY),
    value: requireBoundedString(input, 'value', MAX_VALUE),
    updatedBy: requireBoundedString(input, 'updatedBy', MAX_THREAD_REF),
  };
}

export function parseKvGet(value: unknown): KvGetInput {
  const input = requireRecord(value, 'kv.get input');
  expectOnlyFields(input, ['threadRef', 'key']);
  return {
    threadRef: requireBoundedString(input, 'threadRef', MAX_THREAD_REF),
    key: requireBoundedString(input, 'key', MAX_KEY),
  };
}

export function parseKvList(value: unknown): KvListInput {
  const input = requireRecord(value, 'kv.list input');
  expectOnlyFields(input, ['threadRef']);
  return { threadRef: requireBoundedString(input, 'threadRef', MAX_THREAD_REF) };
}

export function parseKvDelete(value: unknown): KvDeleteInput {
  const input = requireRecord(value, 'kv.delete input');
  expectOnlyFields(input, ['threadRef', 'key']);
  return {
    threadRef: requireBoundedString(input, 'threadRef', MAX_THREAD_REF),
    key: requireBoundedString(input, 'key', MAX_KEY),
  };
}

export type DispatchInput =
  | { readonly operation: 'kv.put'; readonly input: KvPutInput }
  | { readonly operation: 'kv.get'; readonly input: KvGetInput }
  | { readonly operation: 'kv.list'; readonly input: KvListInput }
  | { readonly operation: 'kv.delete'; readonly input: KvDeleteInput }
  | { readonly operation: 'search.query'; readonly input: SearchInput };

/**
 * Parse a retrieval request once, at the boundary.
 *
 * `authorizedCollections`, `signal`, `deadlineAt` and friends are rejected as
 * unknown fields rather than ignored: a caller that sends them is asking the
 * plugin to trust a self-declared grant, and the honest answer is no.
 */
export function parseSearchInput(value: unknown): SearchInput {
  const input = requireRecord(value, 'search.query input');
  expectOnlyFields(input, ['query', 'options']);
  const query = requireBoundedString(input, 'query', MAX_QUERY);
  const raw = input.options === undefined ? {} : requireRecord(input.options, 'search.query options');
  expectOnlyFields(raw, [
    'limit',
    'scope',
    'mode',
    'depth',
    'threadId',
    'dateFrom',
    'dateTo',
    'contextWindow',
    'includePullOnly',
    'explain',
  ]);
  const options: SearchOptionsDto = {
    ...(raw.limit === undefined ? {} : { limit: requireLimit(raw.limit) }),
    ...(raw.scope === undefined ? {} : { scope: requireChoice(raw.scope, 'scope', SEARCH_SCOPES) }),
    ...(raw.mode === undefined ? {} : { mode: requireChoice(raw.mode, 'mode', SEARCH_MODES) }),
    ...(raw.depth === undefined ? {} : { depth: requireChoice(raw.depth, 'depth', SEARCH_DEPTHS) }),
    ...(raw.threadId === undefined ? {} : { threadId: requireBoundedString(raw, 'threadId', MAX_THREAD_REF) }),
    ...(raw.dateFrom === undefined ? {} : { dateFrom: requireBoundedString(raw, 'dateFrom', MAX_KEY) }),
    ...(raw.dateTo === undefined ? {} : { dateTo: requireBoundedString(raw, 'dateTo', MAX_KEY) }),
    ...(raw.contextWindow === undefined ? {} : { contextWindow: requireContextWindow(raw.contextWindow) }),
    ...(raw.includePullOnly === undefined ? {} : { includePullOnly: requireBoolean(raw, 'includePullOnly') }),
    ...(raw.explain === undefined ? {} : { explain: requireBoolean(raw, 'explain') }),
  };
  return { query, options };
}

/** Parse the operation discriminator and its typed input once, at the Host boundary. */
export function parseDispatch(value: unknown): DispatchInput {
  const envelope = requireRecord(value, 'memory.dispatch input');
  if (envelope.input === undefined) throw new TypeError('memory.dispatch input is required');
  switch (envelope.operation) {
    case 'kv.put':
      return { operation: 'kv.put', input: parseKvPut(envelope.input) };
    case 'kv.get':
      return { operation: 'kv.get', input: parseKvGet(envelope.input) };
    case 'kv.list':
      return { operation: 'kv.list', input: parseKvList(envelope.input) };
    case 'kv.delete':
      return { operation: 'kv.delete', input: parseKvDelete(envelope.input) };
    case 'search.query':
      return { operation: 'search.query', input: parseSearchInput(envelope.input) };
    default:
      throw new TypeError(`unknown memory operation: ${String(envelope.operation)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function requireBoundedString(input: Record<string, unknown>, field: string, max: number): string {
  const value = input[field];
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${field} must be a non-empty string`);
  if (value.length > max) throw new TypeError(`${field} exceeds ${max} characters`);
  return value;
}

function requireBoolean(input: Record<string, unknown>, field: string): boolean {
  const value = input[field];
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be a boolean`);
  return value;
}

function requireLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_RESULTS) {
    throw new TypeError(`limit must be an integer between 1 and ${MAX_RESULTS}`);
  }
  return value;
}

/** The live route accepts up to five surrounding passages; the wire says the same. */
function requireContextWindow(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_CONTEXT_WINDOW) {
    throw new TypeError(`contextWindow must be an integer between 1 and ${MAX_CONTEXT_WINDOW}`);
  }
  return value;
}

function requireChoice<const T extends readonly string[]>(
  value: unknown,
  field: string,
  allowed: T,
): T[number] {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new TypeError(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T[number];
}

/** Reject smuggled fields so a narrower operation cannot receive a wider payload. */
function expectOnlyFields(input: Record<string, unknown>, allowed: readonly string[]): void {
  const permitted = new Set(allowed);
  for (const field of Object.keys(input)) {
    if (!permitted.has(field)) throw new TypeError(`unexpected field: ${field}`);
  }
}
