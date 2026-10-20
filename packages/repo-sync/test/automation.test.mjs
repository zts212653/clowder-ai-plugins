import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { synchronize } from '../src/automation.mjs';
import { Receiver } from '../src/engine.mjs';
import { recordDetail } from '../src/records.mjs';
import { Tasks } from '../src/tasks.mjs';
import { repositories } from './fixtures.mjs';
import { issuePlatform } from './issue-fixtures.mjs';

test('one click prepares PR, restart resumes same run, merges settle shared Issue and continue', async () => {
  const f = await repositories(),
    platform = await issuePlatform(f);
  const adapter = join(f.root, 'pr.mjs'),
    database = join(f.root, 'prs.json');
  await writeFile(
    adapter,
    `import{readFileSync,writeFileSync,existsSync}from'node:fs';
const chunks=[];for await(const c of process.stdin)chunks.push(c);const r=JSON.parse(Buffer.concat(chunks));
const file=process.argv[2],db=existsSync(file)?JSON.parse(readFileSync(file)):{};
if(r.action==='create'){db[r.head]={...r,url:'https://codehub.example/core/pull/'+(Object.keys(db).length+1),state:'open'};writeFileSync(file,JSON.stringify(db));}
console.log(JSON.stringify(db[r.head]??null));`,
  );
  const config = {
    ...f.config,
    internalWebUrl: 'https://codehub.example/core',
    issues: platform.config,
    commitStrategy: 'rewrite',
    receivingIdentity: { name: 'Sync', email: 'sync@example.invalid' },
    pullRequests: {
      mode: 'command',
      find: { command: process.execPath, args: [adapter, database] },
      create: { command: process.execPath, args: [adapter, database] },
    },
  };
  let receiver = new Receiver(config);
  await receiver.adopt(f.u0, f.i0);
  await receiver.setQueue(f.plans);
  const input = { action: 'synchronize', requestId: 'a'.repeat(32) };
  await synchronize(receiver, input);
  let state = await receiver.status();
  assert.equal(state.automation.status, 'WAITING_REVIEW');
  assert.equal(state.active.status, 'WAITING_APPROVAL');
  const runId = state.automation.id;
  const tasks = new Tasks(
    () => receiver,
    (input) => synchronize(receiver, input),
  );
  await synchronize(receiver, input);
  assert.equal(Object.keys(JSON.parse(await readFile(database))).length, 1);
  for (let i = 0; i < 2; i++) {
    state = await receiver.status();
    await f.merge(state.active);
    receiver = new Receiver(config);
    await tasks.start({
      action: 'resume-sync',
      runId,
      requestId: String(i + 1).repeat(32),
      expectedBinding: receiver.config.bindingId,
    });
    await tasks.job;
    assert.equal((await tasks.latest()).status, 'SUCCEEDED');
    state = await receiver.status();
    assert.equal(state.deliveries[i].status, 'COMPLETE');
    assert.equal(state.issues['issue-71'].state, i ? 'closed' : 'open');
    assert.equal(state.automation.status, i ? 'COMPLETE' : 'WAITING_REVIEW');
  }
  const history = await recordDetail(receiver, state.deliveries[0].id, new URLSearchParams(), tasks);
  assert.ok(history.tasks.length);
  assert.ok(
    history.tasks.every((task) =>
      task.steps.every((step) => !step.deliveryId || step.deliveryId === state.deliveries[0].id),
    ),
  );
  await tasks.close();
  assert.equal(Object.keys(JSON.parse(await readFile(database))).length, 2);
  await assert.rejects(() => synchronize(receiver, { action: 'resume-sync', runId: 'b'.repeat(32) }), {
    code: 'AUTOMATION_CHANGED',
  });
});
