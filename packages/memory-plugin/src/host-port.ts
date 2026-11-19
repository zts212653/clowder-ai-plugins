import type { MemoryEntryDto } from '@clowder-ai/plugin-memory-contract';

/**
 * Host-authorized thread KV surface.
 *
 * The Host owns authorization and physical key construction. The plugin passes
 * a `threadRef` through verbatim and never derives, prefixes or rebuilds a key;
 * the deployment `default` family is an ordinary authorized thread ref, not a
 * special case the plugin can special-case its way around.
 *
 * Values arrive and leave as the exact stored JSON so the legacy hash reads and
 * writes stay byte-compatible with records written by earlier Host versions.
 */
export interface MemoryThreadKvPort {
  /** Every raw field of the thread hash, exactly as stored. */
  readAll(threadRef: string): Promise<Readonly<Record<string, string>>>;
  /** Store one raw field; the Host sets any TTL/persistence policy. */
  write(threadRef: string, key: string, json: string): Promise<void>;
  /** Remove one field; true when a field existed. */
  remove(threadRef: string, key: string): Promise<boolean>;
}

/**
 * The Host-provisioned memory ports. Supplied on the module host shape; a Host
 * that does not supply them fails admission rather than silently serving an
 * empty memory library.
 */
export interface MemoryHostPorts {
  readonly threadKv: MemoryThreadKvPort;
}

/** Parse a stored raw field; unusable records are skipped exactly as the legacy store did. */
export function readEntry(raw: string | undefined): MemoryEntryDto | null {
  if (raw === undefined) return null;
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
