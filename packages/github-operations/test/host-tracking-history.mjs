import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { installedTrackingHost } from './installed-tracking-host.mjs';
import { artifactImports, seedSettled, seedJournal, seedLiveCollectors, measuredActions } from './installed-tracking-history.mjs';

const hostRoot = await realpath(process.env.CLOWDER_1843_HOST_ROOT ?? 'missing-explicit-host-root');
const artifact = await realpath(process.env.CLOWDER_1843_GITHUB_ARTIFACT_ROOT ?? 'missing-explicit-artifact-root');
const host = path => import(pathToFileURL(join(hostRoot, 'packages/api', path)).href);
const { ownedRedisFixture } = await host('test/helpers/owned-redis-fixture.js');
const { auditRecoveryRedis } = await host('test/helpers/recovery-store-audit.js');
const redisFixture = ownedRedisFixture('1843-installed-history');
const load = artifactImports(artifact);

for (const family of ['typed', 'collection', 'migrated', 'journal']) {
  test(`complete installed PR + issue: ${family} history 1000 -> 10000 preserves bounded empty and actual event rounds`, { timeout: 600_000 }, async t => {
    const measurements = [];
    for (const size of [1000, 10000]) {
      await t.test(`${size} retained rows`, async sample => {
        const f = await installedTrackingHost(sample, { hostRoot, artifact, redisFixture });
        if (family === 'journal') await seedJournal(f, load, size);
        else await seedSettled(f, load, family, 0, size);
        await f.runtime.start('instance', f.record); // Real installed census is complete before periodic measurement.
        const empty = await measuredActions(f, auditRecoveryRedis);
        assert.equal(empty.providerCalls, 0);
        const live = await seedLiveCollectors(f, load);
        await f.call('github.typed-wait.register-pr', { registrationId: 'native-pr', repoFullName: 'owner/repo', prNumber: 1,
          when: [{ kind: 'pr_ci_terminal' }] });
        await f.call('github.typed-wait.register-issue', { registrationId: 'native-issue', repoFullName: 'owner/repo', issueNumber: 1,
          when: [{ kind: 'issue_comment_added', authorLogins: ['not-observed'] }] });
        await f.call('github.pr-tracking'); await f.call('github.issue-tracking'); // Original live baselines.
        assert.equal(f.sends.length, 0);
        f.mode.now += 60_001; f.mode.scenario = 'event:11';
        const event = await measuredActions(f, auditRecoveryRedis);
        assert.equal(event.providerCalls, 5, 'both typed waits, both collection owners and the migrated issue stay awaited');
        assert.equal(f.sends.length, 1, JSON.stringify(f.events));
        assert.deepEqual(f.sends[0].wake, { catId: 'codex61-sol' });
        const original = await f.facade.get(live.legacyKey);
        assert.equal(original.value.task.automationState.issue.lastDeliveredCursor, 11);
        assert.equal(original.value.outbox, undefined);
        const journal = new (await load('business/domains/community/CommunityEventLog.js')).SdkCommunityEventLog(f.facade);
        for (const kind of ['pr', 'issue']) {
          const events = await journal.read(`${kind}:owner/repo#2`);
          assert.ok(events.some(row => row.sourceEventId.includes(':11')), 'a real synthetic event was appended and can be read by original subject');
        }
        measurements.push({ family, size, empty, event });
        console.log(JSON.stringify(measurements.at(-1)));
      });
    }
    assert.equal(measurements.length, 2);
    const [small, large] = measurements;
    assert.equal(large.empty.commands, small.empty.commands, 'empty Redis work is independent of retained history');
    assert.ok(large.event.commands <= small.event.commands + 24,
      `actual event work grew with unrelated history: ${JSON.stringify(measurements)}`);
    assert.equal(large.event.hgetalls, small.event.hgetalls, 'bounded native Task reads are independent of plugin history');
  });
}
