import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { EventMemoryStore } from './events/EventMemoryStore.js';
import type { MemoryHostPorts } from './host-port.js';

export async function openMemoryStorage({ memoryDatabase, memoryData }: MemoryHostPorts): Promise<{
  db: Database.Database;
  events: EventMemoryStore;
  runWrite<T>(work: () => T | Promise<T>): Promise<T>;
  close(): Promise<void>;
}> {
  const binding = `${process.platform}-${process.arch}-abi${process.versions.modules}.node`;
  const nativeBinding = fileURLToPath(new URL(`./native/${binding}`, import.meta.url));
  const db = new Database(memoryDatabase.canonicalPath, { fileMustExist: true, nativeBinding });
  const events = new EventMemoryStore(memoryData.eventDbPath, (path) => new Database(path, { nativeBinding }));
  try {
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    const schema = db.prepare('SELECT MAX(version) FROM schema_version').pluck().get();
    if (schema !== 84) throw new Error(`memory storage format 1 requires schema 84, received ${String(schema)}`);
    if (memoryData.eventDbPath !== ':memory:') await mkdir(dirname(memoryData.eventDbPath), { recursive: true });
    await events.initialize();
  } catch (error) {
    events.close();
    db.close();
    throw error;
  }

  // The activation owns one evidence write queue. All evidence-backed services
  // take this same connection instead of opening their own copy of the queue.
  let pending = Promise.resolve();
  let shutdown: Promise<void> | undefined;
  return {
    db,
    events,
    runWrite<T>(work: () => T | Promise<T>): Promise<T> {
      if (shutdown) return Promise.reject(new Error('memory_storage_closed'));
      const result = pending.then(work);
      pending = result.then(() => undefined, () => undefined);
      return result;
    },
    close() {
      return (shutdown ??= pending.then(() => {
        events.close();
        db.close();
      }));
    },
  };
}
