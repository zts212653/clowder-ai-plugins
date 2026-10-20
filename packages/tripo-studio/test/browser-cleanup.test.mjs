import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import test from 'node:test';
import { launchIsolatedChrome } from '../plugins/tripo-studio/runtime/isolated-chrome.mjs';

test('startup timeout kills the directly owned process and removes its profile before any CDP PID exists', async () => {
  let owned;
  let profile;
  await assert.rejects(
    launchIsolatedChrome({
      executable: 'injected-test-browser',
      startupTimeoutMs: 250,
      spawnBrowser: (_command, args, options) => {
        profile = args.find((arg) => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
        owned = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], options);
        return owned;
      },
    }),
    /ISOLATED_BROWSER_START_TIMEOUT/,
  );
  assert.throws(() => process.kill(owned.pid, 0), { code: 'ESRCH' });
  await assert.rejects(access(profile), { code: 'ENOENT' });
});

test('a spawn error also removes its newly created profile', async () => {
  let profile;
  await assert.rejects(
    launchIsolatedChrome({
      executable: '/nonexistent-tripo-test-browser',
      spawnBrowser: (command, args, options) => {
        profile = args.find((arg) => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
        return spawn(command, args, options);
      },
    }),
    /ISOLATED_BROWSER_START_FAILED/,
  );
  await assert.rejects(access(profile), { code: 'ENOENT' });
});
