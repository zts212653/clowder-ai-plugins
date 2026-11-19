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
 * Thread KV business rules, migrated from the Host's `RedisMemoryStore`.
 *
 * The Host port supplies authorization and physical keys; every rule that
 * decides *what* is stored lives here, so a compatible replacement plugin can
 * change implementation without changing the durable record shape.
 */
export class ThreadKvOperations {
  constructor(
    private readonly port: MemoryThreadKvPort,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async put(input: KvPutInput): Promise<MemoryEntryDto> {
    const existing = await this.port.readAll(input.threadRef);
    const isNewKey = !Object.hasOwn(existing, input.key);

    if (isNewKey && Object.keys(existing).length >= MAX_KEYS_PER_THREAD) {
      const oldest = oldestKey(existing);
      if (oldest !== undefined) await this.port.remove(input.threadRef, oldest);
    }

    const entry: MemoryEntryDto = {
      key: input.key,
      value: input.value,
      threadId: input.threadRef,
      updatedBy: input.updatedBy,
      updatedAt: this.now(),
    };
    await this.port.write(input.threadRef, input.key, JSON.stringify(entry));
    return entry;
  }

  async get(input: KvGetInput): Promise<MemoryEntryDto | null> {
    const all = await this.port.readAll(input.threadRef);
    return readEntry(all[input.key]);
  }

  async list(input: KvListInput): Promise<readonly MemoryEntryDto[]> {
    const all = await this.port.readAll(input.threadRef);
    return Object.values(all)
      .map(readEntry)
      .filter((entry): entry is MemoryEntryDto => entry !== null)
      .sort((left, right) => left.updatedAt - right.updatedAt);
  }

  delete(input: KvDeleteInput): Promise<boolean> {
    return this.port.remove(input.threadRef, input.key);
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
