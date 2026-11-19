import type { MemoryEntryDto } from '@clowder-ai/plugin-memory-contract';

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

/**
 * Host-provisioned memory ports, supplied on the module host shape. A Host that
 * does not supply them fails admission rather than silently serving an empty
 * memory library.
 */
export interface MemoryHostPorts {
  readonly memoryThreadKv: MemoryThreadKvPort;
  readonly memoryDatabase: MemoryDatabasePort;
}

/**
 * The evidence database the Host resolved for this deployment.
 *
 * Only the coordinate travels: the plugin runs in a worker thread and cannot be
 * handed a connection. The plugin opens its own handle on this exact path and
 * never derives one — `dataPath`, the deployment default, or any other root is
 * not a substitute, because that path may name a different file entirely.
 */
export interface MemoryDatabasePort {
  /** Absolute path the Host resolved for evidence storage. Diagnostic and open target only. */
  readonly canonicalPath: string;
  /** Storage format the Host can still read and roll back to. */
  readonly storageFormat: number;
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
