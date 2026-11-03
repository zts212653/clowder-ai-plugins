import assert from 'node:assert/strict';
import test from 'node:test';
import { assertReleasePlans, releaseStatus } from './catalog-release.mjs';

const now = Date.parse('2026-11-03T02:00:00Z');
function fixture() {
  const artifact = version => ({ kind: 'npm', packageName: '@clowder-ai/example', version,
    tarballUrl: `https://registry.npmjs.org/@clowder-ai/example/-/example-${version}.tgz`,
    integrity: `sha512-${Buffer.alloc(64, version.endsWith('2') ? 2 : 1).toString('base64')}`,
    shasum: '1234567890123456789012345678901234567890',
    provenance: { repository: 'https://github.com/example/plugins', sourceDirectory: 'packages/example' } });
  const row = version => ({ version, contractVersion: '0.1.0', manifestPath: 'plugin.yaml', artifact: artifact(version) });
  const entry = versions => ({ pluginId: 'official.example', name: 'Example', description: 'Example',
    icon: { type: 'svg', src: 'assets/icon.svg' }, publisher: { id: 'example', name: 'Example' }, versions: versions.map(row) });
  const live = { schemaVersion: '1', plugins: [entry(['0.1.0-alpha.1'])] };
  const candidate = { schemaVersion: '1', plugins: [entry(['0.1.0-alpha.2', '0.1.0-alpha.1'])] };
  const plan = { pluginId: 'official.example', version: '0.1.0-alpha.2', integrity: artifact('0.1.0-alpha.2').integrity,
    disposition: 'activate', owner: 'codex61-sol', reviewBy: '2026-11-05T08:00:00Z',
    sourceRef: 'https://github.com/example/plugins/pull/1' };
  const plans = { schemaVersion: 1, releases: [plan] };
  return { candidate, live, plan, plans };
}

test('a version PR cannot merge without an exact named release destination', () => {
  const f = fixture();
  assert.throws(() => assertReleasePlans(f.candidate, f.live, { schemaVersion: 1, releases: [] }, { now }),
    /official.example@0.1.0-alpha.2.*release plan/i);
  assert.doesNotThrow(() => assertReleasePlans(f.candidate, f.live, f.plans, { now }));
});

test('a deferred version needs both the dependency and the condition to release it', () => {
  const f = fixture();
  f.plan.disposition = 'defer';
  assert.throws(() => assertReleasePlans(f.candidate, f.live, f.plans, { now }), /reason|condition/i);
  f.plan.reason = 'The paired Host has not admitted the archive.';
  f.plan.condition = 'Paired Host admission and complete owner acceptance pass.';
  assert.doesNotThrow(() => assertReleasePlans(f.candidate, f.live, f.plans, { now }));
});

test('wrong bytes, missing ownership, invalid dates and duplicate release records are rejected', () => {
  for (const [field, value, error] of [
    ['integrity', `sha512-${Buffer.alloc(64, 7).toString('base64')}`, /identity|integrity/i],
    ['owner', '', /owner/i], ['reviewBy', 'later', /review/i],
    ['sourceRef', 'javascript:alert(1)', /source/i], ['disposition', 'maybe', /disposition/i],
  ]) {
    const f = fixture(); f.plan[field] = value;
    assert.throws(() => assertReleasePlans(f.candidate, f.live, f.plans, { now }), error);
  }
  const f = fixture(); f.plans.releases.push({ ...f.plan });
  assert.throws(() => assertReleasePlans(f.candidate, f.live, f.plans, { now }), /duplicate/i);
});

test('a new or edited release plan cannot start already overdue', () => {
  const f = fixture(); f.plan.reviewBy = '2026-11-02T00:00:00Z';
  assert.throws(() => assertReleasePlans(f.candidate, f.live, f.plans, { now }), /future|overdue/i);
  const basePlans = structuredClone(f.plans);
  assert.doesNotThrow(() => assertReleasePlans(f.candidate, f.live, f.plans,
    { now, baseCandidate: f.candidate, basePlans }));
  f.plan.owner = 'sonnet';
  assert.throws(() => assertReleasePlans(f.candidate, f.live, f.plans,
    { now, baseCandidate: f.candidate, basePlans }), /future|overdue/i);
});

test('an old live version cannot excuse a new version even when both catalog files advance together', () => {
  const f = fixture();
  assert.throws(() => assertReleasePlans(f.candidate, f.candidate,
    { schemaVersion: 1, releases: [] }, { now, baseCandidate: f.live }), /release plan/i);
});

test('pending, deferred, overdue and unowned releases are follow-up states without failing main', () => {
  const f = fixture();
  assert.equal(releaseStatus(f.candidate, f.live, f.plans, { now })[0].state, 'activation-pending');
  f.plan.disposition = 'defer'; f.plan.reason = 'Paired Host'; f.plan.condition = 'Acceptance passes';
  assert.equal(releaseStatus(f.candidate, f.live, f.plans, { now })[0].state, 'deferred');
  f.plan.reviewBy = '2026-11-01T00:00:00Z';
  assert.equal(releaseStatus(f.candidate, f.live, f.plans, { now })[0].state, 'overdue');
  f.plans.releases = [];
  assert.equal(releaseStatus(f.candidate, f.live, f.plans, { now })[0].state, 'unowned');
});

test('actual activation resolves a release and does not require a fresh deadline', () => {
  const f = fixture(); f.plan.reviewBy = '2026-11-01T00:00:00Z';
  assert.equal(releaseStatus(f.candidate, f.candidate, f.plans, { now })[0].state, 'active');
  assert.doesNotThrow(() => assertReleasePlans(f.candidate, f.candidate, f.plans,
    { now, baseCandidate: f.candidate, basePlans: f.plans }));
});

test('candidate-only historical rows do not create fresh obligations after current activation', () => {
  const f = fixture(); const live = structuredClone(f.candidate);
  live.plugins[0].versions.pop();
  assert.equal(releaseStatus(f.candidate, live, { schemaVersion: 1, releases: [] }, { now })[0].state, 'active');
});
