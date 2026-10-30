import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  establishPrivateDirectoryAccessForPlatform,
  windowsPowerShell51Environment,
} from '../private-path-access.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('private path boundary', () => {
  it('removes inherited PowerShell 7 module paths before launching Windows PowerShell 5.1', () => {
    const inheritedEnvironment = {
      Path: 'C:\\Windows\\System32',
      PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules',
      psMODULEpath: 'C:\\Users\\fixture\\Documents\\PowerShell\\Modules',
      KEEP_ME: 'inherited',
    };
    const overrides = {
      CLOWDER_COLLECTIVE_PRIVATE_ROOT: 'C:\\fixture\\private',
      PSMODULEPATH: 'must-not-reappear',
      KEEP_ME: 'overridden',
    };

    expect(windowsPowerShell51Environment(overrides, inheritedEnvironment)).toEqual({
      Path: 'C:\\Windows\\System32',
      KEEP_ME: 'overridden',
      CLOWDER_COLLECTIVE_PRIVATE_ROOT: 'C:\\fixture\\private',
    });
    expect(inheritedEnvironment.PSModulePath).toContain('PowerShell\\7');
  });

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
        { ...metadata, uid: Number(metadata.uid) + 1 },
        { owner: 'wrong owner', mode: 'open mode' },
      ),
    ).toThrow('wrong owner');
    expect(() =>
      boundary.assertMetadata(
        { ...metadata, mode: metadata.mode | 0o070 },
        { owner: 'wrong owner', mode: 'open mode' },
      ),
    ).toThrow('open mode');
  });

  it('rejects an existing POSIX root that is not mode 0700', async () => {
    const directory = await temporaryDirectory();
    await chmod(directory, 0o750);
    await expect(establishPrivateDirectoryAccessForPlatform(directory, 'linux', async () => {})).rejects.toThrow(
      'mode 0700',
    );
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'collective-private-path-'));
  directories.push(directory);
  return directory;
}
