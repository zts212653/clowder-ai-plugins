import assert from 'node:assert/strict';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fail } from '../src/config.mjs';
import { configurationLock } from '../src/private-config.mjs';
import { command } from '../src/process.mjs';
import { Store } from '../src/store.mjs';

test('cancel stops the command and its child before releasing execution locks', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'repo-sync-tree-'));
  const file = join(folder, 'child.pid');
  const store = new Store(join(folder, 'state'));
  const controller = new AbortController();
  const script =
    'const cp=require("node:child_process"); const child=cp.spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});require("node:fs").writeFileSync(process.argv[1],String(child.pid));setInterval(()=>{},1000);';
  const running = store.locked(() => command(process.execPath, ['-e', script, file], { signal: controller.signal }));
  for (let i = 0; i < 200; i++) {
    try {
      await access(file);
      break;
    } catch {
      await new Promise((done) => setTimeout(done, 10));
    }
  }
  const pid = Number(await readFile(file, 'utf8'));
  controller.abort();
  await assert.rejects(running, { code: 'OPERATION_CANCELLED' });
  await assert.rejects(access(store.lockPath), { code: 'ENOENT' });
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux')
      assert.match(await readFile(`/proc/${pid}/stat`, 'utf8'), /\) Z /, 'orphan zombie is stopped');
    else assert.fail('child process is still alive');
  } catch (error) {
    if (error.code !== 'ESRCH' && error.code !== 'ENOENT') throw error;
  }
});
test('an unconfirmed process stop preserves both configuration and ledger locks', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'repo-sync-quarantine-'));
  const configFile = join(folder, 'config.json');
  const store = new Store(join(folder, 'state'));
  await assert.rejects(
    configurationLock(configFile, () => store.locked(() => fail('STOP_UNCONFIRMED', 'synthetic stop uncertainty'))),
    { code: 'STOP_UNCONFIRMED' },
  );
  await access(`${configFile}.lock`);
  await access(store.lockPath);
});
