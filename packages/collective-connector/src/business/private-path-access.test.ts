import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { establishPrivateDirectoryAccessForPlatform } from '../private-path-access.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('private path boundary', () => {
  it('does not admit Windows metadata until the DACL protector succeeds', async () => {
    const directory = await temporaryDirectory();
    const attempted: string[] = [];
    const failure = new Error('fixture DACL refusal');
    await expect(
      establishPrivateDirectoryAccessForPlatform(
        directory,
        'win32',
        async (path) => {
          attempted.push(path);
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(attempted).toEqual([directory]);
  });

  it('uses a successfully established Windows DACL instead of POSIX owner and mode bits', async () => {
    const directory = await temporaryDirectory();
    const protectedPaths: string[] = [];
    const boundary = await establishPrivateDirectoryAccessForPlatform(
      directory,
      'win32',
      async (path) => {
        protectedPaths.push(path);
      },
    );
    expect(protectedPaths).toEqual([directory]);
    expect(() =>
      boundary.assertMetadata({ mode: 0o777, uid: 999_999 }, { owner: 'wrong owner', mode: 'open mode' }),
    ).not.toThrow();
  });

  it('retains owner-only POSIX checks after centralizing the platform boundary', async () => {
    const directory = await temporaryDirectory();
    await chmod(directory, 0o700);
    const boundary = await establishPrivateDirectoryAccessForPlatform(directory, 'linux', async () => {});
    const metadata = await stat(directory);
    expect(() =>
      boundary.assertMetadata(metadata, {
        owner: 'wrong owner',
        mode: 'open mode',
      }),
    ).not.toThrow();
    expect(() =>
      boundary.assertMetadata(
        { ...metadata, mode: metadata.mode | 0o077 },
        { owner: 'wrong owner', mode: 'open mode' },
      ),
    ).toThrow('open mode');
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'collective-private-path-'));
  directories.push(directory);
  return directory;
}
