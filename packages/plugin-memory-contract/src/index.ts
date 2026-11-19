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

export type MemoryOperation = (typeof MEMORY_REQUIRED_OPERATIONS)[number];

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

export function memoryDescriptor(): MemoryDescriptor {
  return {
    protocolMajor: MEMORY_PROTOCOL_MAJOR,
    operations: [...MEMORY_REQUIRED_OPERATIONS],
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
  | { readonly operation: 'kv.delete'; readonly input: KvDeleteInput };

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

/** Reject smuggled fields so a narrower operation cannot receive a wider payload. */
function expectOnlyFields(input: Record<string, unknown>, allowed: readonly string[]): void {
  const permitted = new Set(allowed);
  for (const field of Object.keys(input)) {
    if (!permitted.has(field)) throw new TypeError(`unexpected field: ${field}`);
  }
}
