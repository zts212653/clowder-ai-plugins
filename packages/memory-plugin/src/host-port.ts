import type { MemoryEntryDto } from '@clowder-ai/plugin-memory-contract';
import type { MatterSourceReaders } from './matters/matter-source.js';
import type { MatterCallAuthority } from './operations/matter.js';

/**
 * Host-authorized thread KV surface.
 *
 * The Host owns authorization and the physical hash coordinates. The plugin
 * passes a `threadRef` through verbatim and never derives, prefixes or rebuilds
 * a key; the deployment `default` family is an ordinary authorized thread ref,
 * not a special case the plugin can special-case its way around.
 *
 * Values arrive and leave as the exact stored JSON so reads and writes stay
 * byte-compatible with records written by earlier Host versions.
 */
export interface MemoryThreadKvPort {
  /** One raw field, exactly as stored. */
  get(threadRef: string, key: string): Promise<string | null>;
  /** Every raw field of the thread hash: the snapshot a compare-and-set expects. */
  list(threadRef: string): Promise<Record<string, string>>;
  /**
   * Apply `mutation` only when the hash still matches `expected` exactly.
   *
   * This is the Host's atomic executor, not a business rule: it lets the plugin
   * keep the 50-key ceiling and the record shape while a concurrent writer
   * cannot be silently overwritten.
   */
  compareAndSet(
    threadRef: string,
    expected: Record<string, string>,
    mutation: { set: { key: string; value: string }; removeKey?: string },
  ): Promise<boolean>;
  /** Remove one field; true when a field existed. */
  delete(threadRef: string, key: string): Promise<boolean>;
}

/** Existing data coordinates and invocation-bound grants supplied to the official worker. */
export interface MemoryHostPorts {
  readonly memoryThreadKv: MemoryThreadKvPort;
  readonly memoryDatabase: { readonly canonicalPath: string; readonly storageFormat: 1 };
  readonly memoryData: { readonly dataDir: string; readonly eventDbPath: string };
  readonly memorySource: MatterSourceReaders & {
    caller(): Promise<MatterCallAuthority>;
    assertCurrent(): Promise<void>;
    publishMatterChange(): Promise<void>;
  };
}

/** Parse a stored raw field; unusable records are skipped exactly as the legacy store did. */
export function readEntry(raw: string | null | undefined): MemoryEntryDto | null {
  if (raw === null || raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MemoryEntryDto>;
    if (
      typeof parsed.key !== 'string' ||
      typeof parsed.value !== 'string' ||
      typeof parsed.threadId !== 'string' ||
      typeof parsed.updatedBy !== 'string' ||
      typeof parsed.updatedAt !== 'number'
    )
      return null;
    return {
      key: parsed.key,
      value: parsed.value,
      threadId: parsed.threadId,
      updatedBy: parsed.updatedBy,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}
