import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { escrowBootstrapSecret } from '../bootstrap-files.js';

const io = vi.hoisted(() => ({
  directoryOpenCalls: 0,
  directorySyncError: undefined as NodeJS.ErrnoException | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      if (args[1] !== 'r') return actual.open(...args);
      io.directoryOpenCalls += 1;
      return {
        async sync() {
          if (io.directorySyncError) throw io.directorySyncError;
        },
        async close() {},
      } as Awaited<ReturnType<typeof actual.open>>;
    }),
  };
});

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const directories: string[] = [];

beforeEach(() => {
  io.directoryOpenCalls = 0;
  io.directorySyncError = undefined;
});

afterEach(async () => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it('keeps the durable bootstrap file usable when Windows cannot fsync its parent directory', async () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
  io.directorySyncError = Object.assign(new Error('Directory fsync is unsupported on Windows'), { code: 'EPERM' });
  const directory = await mkdtemp(join(tmpdir(), 'collective-windows-bootstrap-'));
  directories.push(directory);

  const secret = await escrowBootstrapSecret(join(directory, 'owner-bootstrap.secret'));

  expect(await readFile(join(directory, 'owner-bootstrap.secret'), 'utf8')).toBe(secret + '\n');
  expect(io.directoryOpenCalls).toBe(0);
});

it('does not hide directory-sync I/O failures on supported platforms', async () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
  io.directorySyncError = Object.assign(new Error('Injected directory outage'), { code: 'EIO' });
  const directory = await mkdtemp(join(tmpdir(), 'collective-directory-error-'));
  directories.push(directory);

  await expect(escrowBootstrapSecret(join(directory, 'owner-bootstrap.secret'))).rejects.toMatchObject({
    code: 'EIO',
  });
  expect(io.directoryOpenCalls).toBe(1);
});
