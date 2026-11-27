import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from '../test/typed-wait-fixture.js';
import { TypedWaitRuntime } from './typed-wait-runtime.js';
import { SdkCommunityEventLog } from './business/domains/community/CommunityEventLog.js';
import { SdkCommunityObjectStore } from './business/domains/community/CommunityObjectStore.js';
import { SdkCommunityRepoConfigStore } from './business/domains/community/CommunityRepoConfigStore.js';
import { CommunityProjector } from './business/domains/community/community-projector.js';
import { ExternalReviewCoordinator } from './business/domains/community/external-review/ExternalReviewCoordinator.js';
import { ExternalReviewVerdictService } from './business/domains/community/external-review/ExternalReviewVerdictService.js';

interface Scenario {
  readonly name: string;
  readonly previous: { readonly catId: string; readonly threadId: string };
  readonly reassigned: boolean;
  readonly expectedNotifications: number;
  readonly anchor?: string;
  readonly commentType?: 'inline' | 'conversation';
}

const scenarios: readonly Scenario[] = [
  { name: 'another cat keeps its notification after reassignment',
    previous: { catId: 'other-cat', threadId: 'home' }, reassigned: true, expectedNotifications: 1 },
  { name: 'another thread keeps its notification after reassignment',
    previous: { catId: 'codex61-sol', threadId: 'other-thread' }, reassigned: true, expectedNotifications: 1 },
  { name: 'an accepted files#r inline receipt remains private',
    previous: { catId: 'codex61-sol', threadId: 'home' }, reassigned: false, expectedNotifications: 0 },
  { name: 'a same-id inline reply survives a conversation self receipt',
    previous: { catId: 'codex61-sol', threadId: 'home' }, reassigned: false,
    anchor: 'issuecomment-77', commentType: 'inline', expectedNotifications: 1 },
  { name: 'a same-id conversation reply survives an inline self receipt',
    previous: { catId: 'codex61-sol', threadId: 'home' }, reassigned: false,
    anchor: 'discussion_r77', commentType: 'conversation', expectedNotifications: 1 },
];

for (const scenario of scenarios) {
  test(scenario.name, async () => {
    const f = fixture(), head = 'a'.repeat(40);
    const objects = new SdkCommunityObjectStore(f.storage), events = new SdkCommunityEventLog(f.storage);
    const projector = new CommunityProjector(events, objects), configs = new SdkCommunityRepoConfigStore(f.storage);
    const configInput = { repo: 'owner/repo', guardCatId: 'guard', guardThreadId: 'guard',
      reviewMode: 'maintainer_review', cloudReviewPolicy: 'optional' } as const;
    const originalConfig = await configs.upsert(configInput);
    const log = { info() {}, warn() {}, error() {} };
    const createCoordinator = () => new ExternalReviewCoordinator({ repoConfigStore: configs, eventLog: events,
      objectStore: objects, projector, log, now: () => 1000 });
    let coordinator = createCoordinator(), now = 1000;
    f.update({ ci: 'pass' });
    const createRuntime = () => new TypedWaitRuntime({ context: f.context, provider: f.provider,
      now: () => now, coverage: async () => ({ covered: true }),
      observe: async (target, snapshot) => {
        assert.ok(snapshot.headSha && snapshot.ci);
        await coordinator.recordCi({ repoFullName: target.repoFullName, prNumber: target.number,
          headSha: snapshot.headSha, aggregateBucket: snapshot.ci }, target);
      } });
    let runtime = createRuntime();
    try {
      const input = { registrationId: 'one', repoFullName: 'owner/repo', prNumber: 1 };
      const task = await runtime.registerPr(input, f.caller);
      for (let n = 2; n <= 4; n++) await runtime.registerPr({ ...input, registrationId: `renew-${n}` }, f.caller);
      for (const sha of ['b'.repeat(40), head]) {
        await coordinator.recordCi({ repoFullName: 'owner/repo', prNumber: 1, headSha: sha,
          aggregateBucket: 'pass' }, scenario.previous);
      }
      const service = new ExternalReviewVerdictService({ repoConfigStore: configs, eventLog: events,
        objectStore: objects, projector, fetchCurrentHead: async () => head, now: () => 2000 });
      const url = scenario.reassigned
        ? 'https://github.com/owner/repo/pull/1#pullrequestreview-42'
        : scenario.anchor ? `https://github.com/owner/repo/pull/1#${scenario.anchor}`
          : 'https://github.com/owner/repo/pull/1/files#r77';
      const result = await service.record({ repoFullName: 'owner/repo', prNumber: 1, reviewedHeadSha: head,
        verdict: scenario.reassigned ? 'approved' : 'commented', summary: 'ok',
        delivery: { kind: 'delivered', githubUrl: url }, principal: scenario.previous });
      assert.equal(result.lifecycle, 'delivered');
      const before = (await objects.get(task.subjectKey!))!.externalReview!;
      assert.equal(before.headGeneration, 2);
      assert.equal(before.lastDeliveredHeadGeneration, 2);
      assert.equal((await runtime.store.get(task.id))!.automationState!.await!.generation, 4);
      const source = `f168:review-verdict:${task.subjectKey}:g2:${before.deliveredVerdictFingerprint}`;
      const recorded = await events.getEvent(source);
      assert.deepEqual(recorded!.payload.principal, scenario.previous);
      if (scenario.reassigned) {
        while (Date.now() <= originalConfig.updatedAt) await new Promise(resolve => setTimeout(resolve, 1));
        await configs.upsert({ ...configInput, guardCatId: 'different-guard' });
        f.update({ reviews: [{ id: 42, author: 'shared-account', state: 'APPROVED', commitId: head }] });
      } else {
        f.update({ comments: [{ id: 77, author: scenario.anchor ? 'contributor' : 'shared-account',
          body: 'review finding', commentType: scenario.commentType ?? 'inline' }] });
      }
      now += 60_001; await runtime.poll('pr');
      const after = (await objects.get(task.subjectKey!))!.externalReview!;
      if (scenario.reassigned) {
        assert.equal(after.reviewerCatId, f.caller.catId);
        assert.equal(after.reviewerThreadId, f.caller.threadId);
        assert.equal(after.delivery?.kind === 'delivered' && after.delivery.githubUrl, url);
      }
      assert.deepEqual(await events.getEvent(source), recorded, 'notification proof preserves immutable delivery history');
      assert.equal(f.sent.length, scenario.expectedNotifications);
      await runtime.stop(); coordinator = createCoordinator(); runtime = createRuntime();
      now += 60_001; await runtime.poll('pr');
      assert.equal(f.sent.length, scenario.expectedNotifications, 'restart never replays consumed evidence');
    } finally { await runtime.stop(); }
  });
}
