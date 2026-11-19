import type {
  KvDeleteInput,
  KvGetInput,
  KvListInput,
  KvPutInput,
  MemoryEntryDto,
} from '@clowder-ai/plugin-memory-contract';

import { readEntry, type MemoryThreadKvPort } from '../host-port.js';

/** Maximum keys per thread, unchanged from the live Host store. */
export const MAX_KEYS_PER_THREAD = 50;

/**
 * How many times a write re-reads and retries before reporting contention.
 *
 * A losing compare-and-set is a real outcome of the design, not an error: the
 * Host executes the mutation only against the snapshot the plugin decided on.
 * Contention on one thread's 50-field hash is rare, so a short bounded retry
 * settles it without waiting on the caller.
 */
const MAX_WRITE_ATTEMPTS = 5;

/**
 * Thread KV business rules, migrated from the Host's `RedisMemoryStore`.
 *
 * The Host port supplies authorization and the physical hash coordinates; every
 * rule that decides *what* is stored lives here, so a compatible replacement
 * plugin can change implementation without changing the durable record shape.
 */
export class ThreadKvOperations {
  constructor(
    private readonly port: MemoryThreadKvPort,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async put(input: KvPutInput): Promise<MemoryEntryDto> {
    const entry: MemoryEntryDto = {
      key: input.key,
      value: input.value,
      threadId: input.threadRef,
      updatedBy: input.updatedBy,
      updatedAt: this.now(),
    };
    const json = JSON.stringify(entry);

    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const expected = await this.port.list(input.threadRef);
      // Only a new key evicts, and only at the ceiling — overwriting an existing
      // key never shrinks the thread.
      const evict =
        !Object.hasOwn(expected, input.key) && Object.keys(expected).length >= MAX_KEYS_PER_THREAD
          ? oldestKey(expected)
          : undefined;
      const applied = await this.port.compareAndSet(input.threadRef, expected, {
        set: { key: input.key, value: json },
        ...(evict === undefined ? {} : { removeKey: evict }),
      });
      if (applied) return entry;
    }
    throw new Error('memory_thread_kv_write_contended');
  }

  async get(input: KvGetInput): Promise<MemoryEntryDto | null> {
    return readEntry(await this.port.get(input.threadRef, input.key));
  }

  async list(input: KvListInput): Promise<readonly MemoryEntryDto[]> {
    const all = await this.port.list(input.threadRef);
    return Object.values(all)
      .map(readEntry)
      .filter((entry): entry is MemoryEntryDto => entry !== null)
      .sort((left, right) => left.updatedAt - right.updatedAt);
  }

  delete(input: KvDeleteInput): Promise<boolean> {
    return this.port.delete(input.threadRef, input.key);
  }
}

/** The field with the smallest readable `updatedAt`; unreadable fields never win eviction. */
function oldestKey(all: Readonly<Record<string, string>>): string | undefined {
  let oldest: { key: string; updatedAt: number } | undefined;
  for (const [key, raw] of Object.entries(all)) {
    const entry = readEntry(raw);
    if (entry === null) continue;
    if (oldest === undefined || entry.updatedAt < oldest.updatedAt) oldest = { key, updatedAt: entry.updatedAt };
  }
  return oldest?.key;
}
