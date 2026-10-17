import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { synchronize } from '../src/automation.mjs';
import { Receiver } from '../src/engine.mjs';
import { git } from '../src/process.mjs';
import { repositories } from './fixtures.mjs';
import { issuePlatform } from './issue-fixtures.mjs';

test('real Git reception closes metadata at each pause boundary and resumes the frozen next PR after restart', async () => {
  const f = await repositories(),
    platform = await issuePlatform(f);
  const adapter = join(f.root, 'boundary-pr.mjs'),
    database = join(f.root, 'boundary-prs.json');
  await writeFile(
    adapter,
    `import{readFileSync,writeFileSync,existsSync}from'node:fs';
let input='';for await(const c of process.stdin)input+=c;const r=JSON.parse(input),p=process.argv[2];
const db=existsSync(p)?JSON.parse(readFileSync(p)):{};
if(r.action==='create'){db[r.head]={...r,url:'https://codehub.example/core/pull/'+(Object.keys(db).length+1),state:'open'};writeFileSync(p,JSON.stringify(db));}
console.log(JSON.stringify(db[r.head]??null));`,
  );
  const config = {
    ...f.config,
    internalWebUrl: 'https://codehub.example/core',
    issues: platform.config,
    commitStrategy: 'rewrite',
    receivingIdentity: { name: 'Boundary Sync', email: 'boundary@example.invalid' },
    pullRequests: {
      mode: 'command',
      find: { command: process.execPath, args: [adapter, database] },
      create: { command: process.execPath, args: [adapter, database] },
    },
  };
  let receiver = new Receiver(config);
  await receiver.adopt(f.u0, f.i0);
  await receiver.setQueue(f.plans);
  const runId = 'c'.repeat(32);
  await synchronize(receiver, { action: 'synchronize', requestId: runId, continuation: 'after-each' });
  let state = await receiver.status();
  const first = state.active;
  assert.equal(state.automation.pauseRequested.afterDeliveryId, first.id);
  await synchronize(receiver, { action: 'pause-sync', runId });
  assert.equal((await receiver.status()).automation.status, 'WAITING_REVIEW');
  await f.merge(first);
  receiver = new Receiver(config);
  await synchronize(receiver, { action: 'resume-sync', runId, observeOnly: true });
  state = await receiver.status();
  assert.equal(state.automation.status, 'PAUSED');
  assert.equal(state.active, undefined);
  assert.equal(state.deliveries[0].status, 'COMPLETE');
  assert.equal(state.accepted.upstream, f.u1);
  assert.equal(state.issues['issue-71'].receipts.length, 1);
  assert.equal(state.issues['issue-71'].state, 'open', 'shared Issue waits for the later required PR');
  const frozen = await receiver.read(),
    refs = await git(f.internal, ['show-ref']);
  await assert.rejects(access(receiver.store.lockPath), { code: 'ENOENT' });
  await synchronize(receiver, { action: 'resume-sync', runId, observeOnly: true });
  assert.deepEqual(await receiver.read(), frozen);
  assert.equal(await git(f.internal, ['show-ref']), refs);
  assert.equal(Object.keys(JSON.parse(await readFile(database, 'utf8'))).length, 1);
  assert.equal((await platform.read()).creates, 1);
  await synchronize(receiver, { action: 'resume-sync', runId });
  state = await receiver.status();
  assert.equal(state.active.target, f.u2);
  assert.equal(state.automation.continuation, 'after-each');
  assert.equal(state.automation.pauseRequested.afterDeliveryId, state.active.id);
  await f.merge(state.active);
  receiver = new Receiver(config);
  await synchronize(receiver, { action: 'resume-sync', runId, observeOnly: true });
  state = await receiver.status();
  assert.equal(state.automation.status, 'COMPLETE');
  assert.equal(state.queue.length, 0);
  assert.equal(state.issues['issue-71'].state, 'closed');
  assert.equal(state.issues['issue-71'].receipts.length, 2);
  assert.equal(Object.keys(JSON.parse(await readFile(database, 'utf8'))).length, 2);
  await assert.rejects(access(receiver.store.lockPath), { code: 'ENOENT' });
});
