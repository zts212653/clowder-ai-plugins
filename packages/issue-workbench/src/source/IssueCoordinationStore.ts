import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, readdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Versioned } from '../model/issue-coordination.js';

export class CoordinationConflict extends Error {
  readonly status = 409;
}
/** Isolated owner root. Authored records have no TTL. Never point tests at production. */
export class IssueCoordinationStore {
  constructor(private readonly root: string) {}
  private directory(partition: string) {
    return join(this.root, createHash('sha256').update(partition).digest('hex'));
  }
  private path(partition: string, key: string) {
    return join(this.directory(partition), createHash('sha256').update(key).digest('hex') + '.json');
  }
  async read<T>(partition: string, key: string): Promise<Versioned<T> | null> {
    try {
      return JSON.parse(await readFile(this.path(partition, key), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async list<T>(partition: string): Promise<Versioned<T>[]> {
    let names: string[];
    try {
      names = await readdir(this.directory(partition));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return Promise.all(
      names
        .filter((n) => n.endsWith('.json'))
        .map(async (n) => JSON.parse(await readFile(join(this.directory(partition), n), 'utf8'))),
    );
  }
  async put<T>(partition: string, key: string, value: T, expectedRevision: number): Promise<Versioned<T>> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('Invalid revision');
    await mkdir(this.directory(partition), { recursive: true, mode: 0o700 });
    const path = this.path(partition, key),
      lockPath = path + '.lock',
      temporary = path + '.' + randomUUID() + '.tmp';
    let lock;
    try {
      lock = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new CoordinationConflict('其他页面正在保存，请保留输入并重新读取');
      throw error;
    }
    try {
      const previous = await this.read<T>(partition, key);
      if ((previous?.revision ?? 0) !== expectedRevision)
        throw new CoordinationConflict('其他页面已修改此记录，请保留输入并重新读取');
      const next = { revision: expectedRevision + 1, value };
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(next));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
      return next;
    } finally {
      await lock.close();
      await unlink(lockPath);
      await unlink(temporary).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
}
