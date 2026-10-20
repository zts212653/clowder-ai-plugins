import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { validateConfig } from '../src/config.mjs';
import { Receiver } from '../src/engine.mjs';
import { versionRepositories } from './version-fixtures.mjs';

async function fixture(behavior = 'normal') {
  const f = await versionRepositories();
  const script = join(f.root, 'platform-adapter.mjs');
  const database = join(f.root, 'platform.json');
  await writeFile(
    script,
    `import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk);
const request=JSON.parse(Buffer.concat(chunks)); const file=process.argv[2];
const db=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{count:0, object:null};
if(request.action==='create') {
 db.count++; db.object={...request, url:'https://codehub.example/core/pull/501', state:'open'};
 if(${JSON.stringify(behavior)}==='mismatch') db.object.head='0'.repeat(40);
 writeFileSync(file,JSON.stringify(db));
 if(${JSON.stringify(behavior)}==='lost') process.exit(1);
}
console.log(JSON.stringify(request.action==='find'?db.object:db.object));`,
  );
  const config = {
    ...f.config,
    internalWebUrl: 'https://codehub.example/core',
    pullRequests: {
      mode: 'command',
      find: { command: process.execPath, args: [script, database] },
      create: { command: process.execPath, args: [script, database] },
    },
  };
  const prepared = new Receiver({ ...config, pullRequests: undefined });
  const receiver = prepared;
  await receiver.adopt(f.u0, f.i0);
  await receiver.selectTag('v2.0.0');
  await receiver.start();
  await receiver.prepare();
  return { f, config, database, receiver: new Receiver(config) };
}
test('automatic PR creation queries and reads back exact branches and head, reuses on retry', async () => {
  const { receiver, database } = await fixture();
  await receiver.createPr();
  await receiver.createPr();
  assert.equal(JSON.parse(await readFile(database)).count, 1);
  const delivery = (await receiver.status()).active;
  assert.equal(delivery.prReference.verifiedBy, 'adapter');
  assert.equal(delivery.prUrl, 'https://codehub.example/core/pull/501');
  assert.equal((await receiver.git.heads()).internal, delivery.base.internal);
});
test('configured command adapter runs automatically when resuming a published candidate', async () => {
  const { receiver, database } = await fixture();
  await receiver.prepare();
  assert.equal((await receiver.status()).active.status, 'WAITING_APPROVAL');
  assert.equal(JSON.parse(await readFile(database)).count, 1);
});
test('lost creation receipt resumes by finding the same PR after process restart, never creates twice', async () => {
  const { receiver, config, database } = await fixture('lost');
  await assert.rejects(() => receiver.createPr());
  const resumed = new Receiver(config);
  await resumed.createPr();
  assert.equal(JSON.parse(await readFile(database)).count, 1);
  assert.equal((await resumed.status()).active.status, 'WAITING_APPROVAL');
});
test('adapter mismatch never registers a PR or creates a second object', async () => {
  const { receiver, database } = await fixture('mismatch');
  await assert.rejects(() => receiver.createPr(), { code: 'PR_OBJECT_MISMATCH' });
  await assert.rejects(() => receiver.createPr(), { code: 'PR_OBJECT_MISMATCH' });
  assert.equal((await receiver.status()).active.prUrl, undefined);
  assert.equal(JSON.parse(await readFile(database)).count, 1);
});
test('an unresolved persisted creation intent with no result cannot be retried as a new create', async () => {
  const { receiver, database } = await fixture();
  const state = await receiver.read();
  state.deliveries[0].prCreation = { status: 'INTENT_SAVED' };
  await receiver.store.save(state);
  await assert.rejects(() => receiver.createPr(), { code: 'PR_CREATE_RESULT_UNKNOWN' });
  await assert.rejects(() => readFile(database), { code: 'ENOENT' });
});
test('platform executable cannot be supplied by the browser and invalid adapter fails early', () => {
  const config = {
    sourceUrl: 'https://github.com/example/core.git',
    internalUrl: 'git@codehub.example:team/core.git',
    sourceBranch: 'main',
    targetBranch: 'main',
    stateDir: 'G:/private/state',
  };
  assert.throws(() => validateConfig({ ...config, pullRequests: { mode: 'command' } }), { code: 'INVALID_PR_ADAPTER' });
});
test('automatic lookup does not overwrite a different manual reference', async () => {
  const { receiver, database } = await fixture();
  await receiver.createPr();
  await receiver.linkPr('https://codehub.example/core/pull/502', {
    previousUrl: 'https://codehub.example/core/pull/501',
  });
  await assert.rejects(() => receiver.createPr(), { code: 'PR_MAPPING_CONFLICT' });
  assert.equal((await receiver.status()).active.prUrl, 'https://codehub.example/core/pull/502');
  assert.equal(JSON.parse(await readFile(database)).count, 1);
});
test('operator withdrawal blocks adapter lookup from reinstating the old PR reference', async () => {
  const { receiver, database } = await fixture();
  await receiver.createPr();
  await receiver.linkPr(null, { previousUrl: 'https://codehub.example/core/pull/501' });
  await assert.rejects(() => receiver.createPr(), { code: 'PR_REFERENCE_WITHDRAWN' });
  assert.equal((await receiver.status()).active.prUrl, undefined);
  assert.equal(JSON.parse(await readFile(database)).count, 1);
});
