import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { terminalFixture, terminalSnapshot, subject, target, head, time, nativeHistory } from '../test/terminal-fixture.js';
import { TerminalFactCollection } from './terminal-fact-collection.js';
import { communityProgressKey } from './legacy-repository-progress.js';
import { CommunityProjector } from './business/domains/community/community-projector.js';
import { providerStateEvidence } from './business/domains/community/provider-open-observation.js';
import { GitHubRepoWebhookHandler } from './business/infrastructure/connectors/github-repo-event/GitHubRepoWebhookHandler.js';
import { providerObservation } from './community-read-model.js';

for (const checkpoint of ['old', 'absent'] as const) test(`committed opening rejects a stale signed close after checkpoint failure (${checkpoint})`, async t => {
  const f = await terminalFixture(); t.after(() => f.community.stop());
  await f.community.collectTracking(target, checkpoint === 'old' ? terminalSnapshot('closed')
    : { state: 'closed', comments: [], reviews: [] });
  const native = (await f.community.objects.get(subject))!.externalReview;
  const key = communityProgressKey('terminal-observation', subject), oldCheckpoint = await f.storage.get(key);
  assert.equal(!!oldCheckpoint, checkpoint === 'old');
  const interrupted = new TerminalFactCollection({ ...f.storage, set: async (name, value) => {
    if (name === key) throw new Error('checkpoint interrupted');
    return f.storage.set(name, value);
  } }, f.community.events, f.projector, f.community.projectionOperations);
  const opening = { headSha: head, observedAt: time + 10000,
    providerUpdatedAt: new Date(time + 10000).toISOString() };
  await assert.rejects(interrupted.collect(subject, [], undefined, false, opening), /checkpoint interrupted/);
  const committed = await f.community.events.read(subject);
  assert.equal(committed.at(-1)?.kind, 'pr.open_observed');
  assert.deepEqual(await f.storage.get(key), oldCheckpoint);

  // Recreate the consumers without retrying the interrupted write. The journal,
  // rather than a successfully saved watermark, must reject this old webhook.
  const projector = new CommunityProjector(f.community.events, f.community.objects, f.community.projectionOperations);
  const collector = new TerminalFactCollection(f.storage, f.community.events, projector, f.community.projectionOperations);
  let deliveries = 0;
  const handler = new GitHubRepoWebhookHandler({ webhookSecret: 'isolated-test-secret', repoAllowlist: [target.repoFullName] }, {
    eventLog: f.community.events, projector,
    mayObserveTerminalFacts: value => collector.allowed(value),
    collectTerminalFacts: async facts => !(await collector.collect(subject, [], facts)).denied,
    dedup: { claim: async () => true, confirm: async () => {}, rollback: async () => {} },
    deliver: async () => { deliveries++; return { messageId: 'unexpected-old-close' }; },
  });
  const body = { action: 'closed', repository: { full_name: target.repoFullName }, pull_request: {
    number: 12, title: 'Delayed previous close', html_url: 'https://github.com/example/project/pull/12',
    user: { login: 'contributor' }, state: 'closed', merged: false, head: { sha: head },
    closed_at: terminalSnapshot('closed').terminalFacts!.closedAt, body: 'Earlier period' } };
  const raw = Buffer.from(JSON.stringify(body));
  const result = await handler.handleWebhook(body, { 'x-github-event': 'pull_request',
    'x-github-delivery': 'interrupted-open-' + checkpoint, 'x-hub-signature-256': 'sha256=' +
      createHmac('sha256', 'isolated-test-secret').update(raw).digest('hex') }, raw);
  assert.equal(result.kind, 'processed'); assert.equal(deliveries, 0);
  assert.deepEqual(await f.community.events.read(subject), committed, 'neither facts nor lifecycle tail is appended');
  assert.deepEqual(await f.storage.get(key), oldCheckpoint);
  const durable = providerStateEvidence(committed)!;
  assert.equal(durable.updatedAt, opening.providerUpdatedAt); assert.equal(durable.observedAt, opening.observedAt);
  await projector.rebuild(subject);
  const rebuilt = await f.community.objects.get(subject);
  assert.equal(rebuilt?.providerOpen?.headSha, head);
  assert.equal(providerObservation(subject, committed, rebuilt).state, 'open');
  assert.deepEqual(nativeHistory(rebuilt?.externalReview), nativeHistory(native));
  await projector.rebuild(subject); assert.deepEqual(await f.community.objects.get(subject), rebuilt);

  const merged = terminalSnapshot().terminalFacts!;
  await collector.collect(subject, [], { ...merged, observedAt: time + 30000,
    closedAt: new Date(time + 20000).toISOString(), mergedAt: new Date(time + 20000).toISOString(),
    ci: { ...merged.ci!, observedAt: time + 30000 } });
  const final = await f.community.objects.get(subject);
  assert.equal(final?.terminalFacts?.state, 'merged'); assert.equal(final?.providerOpen, undefined);
  assert.deepEqual(nativeHistory(final?.externalReview), nativeHistory(native));
  await projector.rebuild(subject); assert.deepEqual(await f.community.objects.get(subject), final);
  assert.equal(f.sends(), 0);
});
