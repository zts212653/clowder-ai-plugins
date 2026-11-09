import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

// Explicit paired-repository acceptance, outside the standalone package test lane.
// Both roots must be supplied; this never discovers or contacts a running Host.
const hostRoot = await realpath(process.env.CLOWDER_1843_HOST_ROOT ?? 'missing-explicit-host-root');
const artifact = await realpath(process.env.CLOWDER_1843_GITHUB_ARTIFACT_ROOT ?? 'missing-explicit-artifact-root');
const host = path => import(pathToFileURL(join(hostRoot, 'packages/api', path)).href);
const { executionFixture } = await host('test/helpers/module-execution-fixture.js');
const { ownedRedisFixture } = await host('test/helpers/owned-redis-fixture.js');
const { auditRecoveryRedis } = await host('test/helpers/recovery-store-audit.js');
const { RedisPluginPrivateStorage } = await host('dist/domains/plugin/host-surface/plugin-private-storage.js');
const { withPluginCallContext } = await host('dist/domains/plugin/carrier/plugin-call-context.js');
const { waitKey } = await import(pathToFileURL(join(artifact, 'dist/typed-wait-record.js')).href);
const redisFixture = ownedRedisFixture('1843-installed-github-wait');
const sdk = pathToFileURL(join(artifact, 'node_modules/@clowder-ai/plugin-sdk/dist/index.js')).href;
const runtime = pathToFileURL(join(artifact, 'dist/typed-wait-runtime.js')).href;
const methods = ['register', 'poll', 'prepare', 'state', 'mode'];
const source = `import { definePlugin, definePluginModule } from ${JSON.stringify(sdk)};
import { TypedWaitRuntime } from ${JSON.stringify(runtime)};
export default definePluginModule(manifest => definePlugin({ manifest, activate: { main: async context => {
  let now = 1000, failing = false, reads = 0;
  const owner = new TypedWaitRuntime({ context, now: () => now, coverage: async () => ({covered:true}),
    provider: {read: async () => { reads++; if (failing) throw new Error('isolated provider failure');
      return {state:'open',headSha:'a'.repeat(40),ci:'pending',comments:[],reviews:[],commentsComplete:true,
        trackingIdentity:{selfLogin:'owner',subjectAuthorLogin:'owner'}}; }} });
  return { actions: {
    register: (input, caller) => owner.registerPr(input, caller),
    poll: () => owner.poll('pr'), prepare: () => owner.store.recovery.initialize(),
    state: async input => ({reads,task:input.id ? await owner.store.get(input.id):null,
      recovery:input.id ? await owner.store.recovery.facts(input.id):null}),
    mode: input => {now = input.at; failing = input.failing === true;},
  }, dispose: () => owner.stop() };
} } }));`;

async function fixture(t) {
  const redis = redisFixture.client(`${randomUUID()}:`), storage = new RedisPluginPrivateStorage(redis);
  const contributions = methods.map(method => ({ type: 'tool', id: method, name: method,
    inputSchema: { type: 'object' }, action: { method } }));
  const f = await executionFixture(t, source, { storage, manifest: {
    contributions, features: [{ id: 'main', name: 'Paired installed GitHub acceptance', resources: [],
      capabilities: ['plugin.state.get', 'plugin.state.set'],
      contributions: methods.map(id => ({ type: 'tool', id })) }],
  } });
  const call = (method, input = {}) => withPluginCallContext('instance', { userId: 'owner', catId: 'codex61-sol',
    threadId: 'home', invocationId: 'isolated-installed-turn', ownerAuthProvenance: 'user_message',
    assertCurrent: async () => {} }, () => f.runtime.invoke('instance', method, input));
  return { ...f, redis, storage, call };
}

test('installed SDK + GitHub business + actual Host facade/worker stay bounded with tenfold settled wait history', async t => {
  const sdkManifest = JSON.parse(await readFile(join(artifact, 'node_modules/@clowder-ai/plugin-sdk/package.json'), 'utf8'));
  assert.equal(sdkManifest.version, '0.3.0-beta.2-candidate.11');
  const readCounts = [];
  for (const count of [1000, 10000]) {
    const f = await fixture(t), pipeline = f.redis.pipeline();
    for (let n = 0; n < count; n++) {
      const task = { id: `history-${n}`, kind: 'pr_tracking', status: 'done', title: 'Retained history',
        threadId: 'home', userId: 'owner', ownerCatId: 'codex61-sol', createdAt: 1, updatedAt: 1,
        createdBy: 'system', subjectKey: `pr:owner/repo#${n + 1}` };
      pipeline.hset(`plugin-private-state:v1:${encodeURIComponent(f.manifest.pluginId)}`, waitKey(task.id),
        `${n + 1}:v:${JSON.stringify({ schemaVersion: 1, task })}`);
    }
    for (const [error] of await pipeline.exec()) assert.equal(error, null);
    await f.runtime.start('instance', f.record);
    await f.call('prepare');
    const audit = await auditRecoveryRedis(f.redis);
    try {
      await f.call('poll'); await audit.flush(); audit.assertIndexed();
      assert.equal(audit.reads.some(row => ['hscan', 'hgetall', 'smembers'].includes(row.command)), false);
      assert.ok(audit.reads.length < 20);
      readCounts.push(audit.reads.length);
      assert.equal((await f.call('state')).reads, 0);
      assert.equal(f.events.filter(event => event.message === 'GitHub wait recovery round').length, 1);
    } finally { audit.stop(); await f.runtime.stop('instance', 'isolated-case-complete'); }
  }
  assert.equal(readCounts[0], readCounts[1], 'zero result must mean constant store work, not a filtered full scan');
});

test('installed worker replacement preserves the original private wait and its exhausted budget without command or provider replay', async t => {
  const f = await fixture(t);
  await f.runtime.start('instance', f.record);
  const tracked = await f.call('register', { registrationId: 'same-original', repoFullName: 'owner/repo', prNumber: 12 });
  for (let n = 1; n <= 10; n++) {
    await f.call('mode', { at: 1000 + n * 60_001, failing: true }); await f.call('poll');
  }
  const before = await f.call('state', { id: tracked.id });
  assert.equal(before.reads, 6); assert.equal(before.recovery.failures, 5);
  assert.equal(before.recovery.disposition, 'needs_attention'); assert.notEqual(before.task.status, 'done');
  const original = await f.storage.get(f.manifest.pluginId, waitKey(tracked.id));
  await f.runtime.stop('instance', 'isolated-worker-replacement');
  await f.runtime.start('instance', f.record);
  await f.call('mode', { at: 10_000_000, failing: true }); await f.call('poll');
  const cold = await f.call('state', { id: tracked.id });
  assert.equal(cold.reads, 0); assert.equal(cold.task.id, tracked.id);
  assert.deepEqual(await f.storage.get(f.manifest.pluginId, waitKey(tracked.id)), original);
  assert.equal(await f.storage.get('other/plugin', waitKey(tracked.id)), undefined);
});
