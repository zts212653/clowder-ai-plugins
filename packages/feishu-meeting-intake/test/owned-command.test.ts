import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, readdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  configureOwnedLarkHome,
  prepareOwnedLarkHome,
  createOwnedLarkCommand,
  materializeOwnedLarkRunner,
} from '../src/owned-lark-command.js';
const current = async () => {};
const temporary = () => mkdtemp(join(tmpdir(), 'owned-meeting-account-'));

test('owned credential compartment retains one local master, authenticates ciphertext and never adopts ambient credentials', async () => {
  const home = await temporary();
  try {
    await configureOwnedLarkHome(home, 'cli_fixture', 'private-fixture-secret', current);
    const root = process.platform === 'darwin' ? join(home, 'Library','Application Support','lark-cli') : join(home,'.local','share','lark-cli');
    const key = await readFile(join(root, process.platform === 'darwin' ? 'master.key.file' : 'master.key'));
    await configureOwnedLarkHome(home, 'cli_fixture', 'private-fixture-secret', current);
    assert.deepEqual(await readFile(join(root, process.platform === 'darwin' ? 'master.key.file' : 'master.key')), key);
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm',key,nonce);
    const encoded = Buffer.concat([nonce,cipher.update('owned token fixture'),cipher.final(),cipher.getAuthTag()]);
    await writeFile(join(root, 'fixture.enc'), encoded, { mode: 0o600 });
    await prepareOwnedLarkHome(home,current);
    encoded[15]! ^= 1;
    await writeFile(join(root, 'fixture.enc'), encoded);
    await assert.rejects(() => prepareOwnedLarkHome(home,current), /recovery required/);
    assert.deepEqual(await readFile(join(root, 'fixture.enc')), encoded, 'corrupt evidence is retained');
    await assert.rejects(() => configureOwnedLarkHome(home, 'cli_other', 'other-secret', current));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('credential path aliases are rejected before private master creation', async () => {
  const home = await temporary(), outside = await temporary();
  try {
    await symlink(outside, join(home,process.platform === 'darwin' ? 'Library' : '.local'));
    await assert.rejects(() => prepareOwnedLarkHome(home,current), /directory.*invalid/);
    assert.deepEqual(await readdir(outside), []);
  } finally { await rm(home,{ recursive:true,force:true }); await rm(outside,{ recursive:true,force:true }); }
});

async function assertRunnerAliasRejected(alias: 'root' | 'platform'): Promise<void> {
  const home = await temporary(), outside = await temporary();
  const platform = `${process.platform}-${process.arch}`;
  const runnerRoot = join(home, '.clowder-runner');
  const outsidePlatform = join(outside, platform);
  const outsideRunner = join(outsidePlatform, 'lark-cli');
  const sentinel = Buffer.from(`outside-${alias}-sentinel`);
  try {
    await mkdir(outsidePlatform, { recursive: true, mode: 0o700 });
    await writeFile(outsideRunner, sentinel, { mode: 0o600 });
    if (alias === 'root') await symlink(outside, runnerRoot);
    else {
      await mkdir(runnerRoot, { mode: 0o700 });
      await symlink(outsidePlatform, join(runnerRoot, platform));
    }
    let failure: unknown;
    try { await materializeOwnedLarkRunner(home, current); }
    catch (error) { failure = error; }
    const externalDigest = createHash('sha256').update(await readFile(outsideRunner)).digest('hex');
    const sentinelDigest = createHash('sha256').update(sentinel).digest('hex');
    assert.equal(externalDigest, sentinelDigest, 'runner materialization must not overwrite an aliased external file');
    assert.match(String(failure), /private directory is invalid/);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}

test('runner root aliases are rejected without changing the external sentinel', async () => {
  await assertRunnerAliasRejected('root');
});

test('runner platform aliases remain rejected without changing the external sentinel', async () => {
  await assertRunnerAliasRejected('platform');
});

test('command abort kills the actual owned process group, including a child that ignores SIGTERM', async () => {
  const home = await temporary();
  const realSpawn = childProcess.spawn;
  const runner = join(home, 'runner.cjs');
  await writeFile(runner, `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const path=require('node:path');
const child=spawn(process.execPath,['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'inherit'});
process.on('SIGTERM',()=>{});fs.writeFileSync(path.join(process.env.HOME,'pids.json'),JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`);
  let childEnv: NodeJS.ProcessEnv | undefined;
  childProcess.spawn = ((executable: string, _args: readonly string[], options: Parameters<typeof realSpawn>[2]) => {
    childEnv = options?.env;
    assert.equal(executable, join(home, '.clowder-runner', `${process.platform}-${process.arch}`, 'lark-cli'));
    return realSpawn(process.execPath,[runner],options);
  }) as typeof realSpawn;
  syncBuiltinESMExports();
  const abort = new AbortController();
  try {
    const result = createOwnedLarkCommand(home,current)(['auth','status','--json'],abort.signal);
    let pids: number[] = [];
    for (let attempt=0;attempt<100;attempt++) {
      try { pids=JSON.parse(await readFile(join(home,'pids.json'),'utf8')); break; } catch { await new Promise(resolve=>setTimeout(resolve,10)); }
    }
    assert.equal(pids.length,2);
    assert.deepEqual(childEnv,{HOME:home});
    abort.abort(new Error('fixture cancelled'));
    await assert.rejects(result,/fixture cancelled/);
    for (const pid of pids) {
      let dead=false;
      for(let attempt=0;attempt<100;attempt++) { try { process.kill(pid,0); } catch(error) { dead=(error as NodeJS.ErrnoException).code==='ESRCH'; if(dead)break; } await new Promise(resolve=>setTimeout(resolve,10)); }
      assert.equal(dead,true,`Owned child ${pid} survived abort`);
    }
  } finally { childProcess.spawn=realSpawn;syncBuiltinESMExports();abort.abort();await rm(home,{recursive:true,force:true}); }
});
