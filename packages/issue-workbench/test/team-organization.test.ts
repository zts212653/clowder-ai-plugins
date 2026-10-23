import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GhTeamProvider } from '../src/team/github.js';
import { setup } from './helpers/team-fixture.js';

const signal = new AbortController().signal;
const membership = { state: 'active', organization: { login: 'meow-club' } };
test('organization roster verifies full visibility and reads every page, normalizing member identities', async () => {
  const calls: string[][] = [];
  const provider = new GhTeamProvider(async args => {
    calls.push(args);
    if (args[3] === 'user/memberships/orgs/meow-club') return JSON.stringify(membership);
    assert.equal(args[3], 'orgs/meow-club/members?per_page=100&filter=all&role=all');
    assert.ok(args.includes('--paginate')); assert.ok(args.includes('--slurp'));
    return JSON.stringify([[{ login: 'BOB', type: 'User' }], [{ login: 'Alice', type: 'User' }, { login: 'bob', type: 'User' }]]);
  });
  assert.deepEqual(await provider.organizationMembers('https://github.com/Meow-Club/', signal), ['alice', 'bob']);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(args => !args.includes('POST')));
});

test('organization failures never turn public-only, partial or unverified results into a staff roster', async () => {
  for (const value of [{ ...membership, state: 'pending' }, { ...membership, organization: { login: 'other' } }, null]) {
    let calls = 0;
    const provider = new GhTeamProvider(async () => { calls++; return JSON.stringify(value); });
    await assert.rejects(provider.organizationMembers('meow-club', signal), /组织|Organization/);
    assert.equal(calls, 1);
  }
  for (const response of ['[{"login":"alice","type":"User"}]', '[[],{}]', '[[{"login":"../bad","type":"User"}]]']) {
    const provider = new GhTeamProvider(async args => args[3].startsWith('user/') ? JSON.stringify(membership) : response);
    await assert.rejects(provider.organizationMembers('meow-club', signal), /组织|Organization/);
  }
  const denied = new GhTeamProvider(async () => { throw new Error('HTTP 403 credential=private'); });
  await assert.rejects(denied.organizationMembers('meow-club', signal), error =>
    error instanceof Error && /403/.test(error.message) && !/credential=private/.test(error.message));
});

test('organization input cannot supply a host, query, credential or repository path to gh', async () => {
  let calls = 0;
  const provider = new GhTeamProvider(async () => { calls++; return '{}'; });
  for (const value of ['../bad', 'meow-club/repo', 'https://evil.test/meow-club', 'https://github.com/meow-club?role=admin',
    'https://user@github.com/meow-club', 'https://github.com:444/meow-club', '--hostname=evil.test']) {
    await assert.rejects(provider.organizationMembers(value, signal));
  }
  assert.equal(calls, 0);
});

test('runtime selects live organization members and ignores a legacy manual roster', async () => {
  const s = setup();
  s.config.teamOrganization = 'https://github.com/meow-club';
  s.config.teamMembers = 'alice,outsider'; s.config.teamGroupName = 'Old roster';
  const requests: string[] = [];
  s.provider.organizationMembers = async org => { requests.push(org); return ['bob']; };
  s.issues[0].author = 'bob'; s.provider.assignable = async () => true;
  const r = s.runtime();
  const job = await r.invoke('analyze', { repo: 'fixture/repo', number: 1, requestId: 'org' }, s.caller('requester')) as any;
  await r.invoke('submit', { id: job.id, analysis: s.analysis }, s.caller());
  assert.deepEqual(s.writes, ['bob']);
  assert.ok(requests.length >= 3, 'membership is checked again before external effects');
  assert.ok(requests.every(org => org === 'meow-club'));
  const detail = await r.invoke('get', { id: job.id }, s.caller()) as any;
  assert.deepEqual(detail.assignmentOptions.members, ['bob']);
  assert.equal(detail.assignmentOptions.organization, 'meow-club');
  assert.equal(detail.assignmentOptions.basis, 'reporter');
});

test('lost organization access preserves analysis and cannot fall back to a manually configured member', async () => {
  const s = setup(); s.config.teamOrganization = 'meow-club';
  s.provider.organizationMembers = async () => { throw new Error('Organization access unavailable'); };
  const r = s.runtime();
  const job = await r.invoke('analyze', { repo: 'fixture/repo', number: 1, requestId: 'denied' }, s.caller('requester')) as any;
  const result = await r.invoke('submit', { id: job.id, analysis: s.analysis }, s.caller()) as any;
  assert.deepEqual(s.writes, []); assert.deepEqual(s.dispatches, []);
  assert.ok(result.analysis);
  const detail = await r.invoke('get', { id: job.id }, s.caller()) as any;
  assert.deepEqual(detail.assignmentOptions.members, []);
  assert.match(detail.assignmentOptions.error, /Organization/);
});

test('missing organization and an organization switch during retrieval cannot authorize assignment', async () => {
  for (const changeDuringRead of [false, true]) {
    const s = setup();
    s.config.teamGroupName = 'Legacy'; s.config.teamMembers = 'alice';
    if (!changeDuringRead) delete s.config.teamOrganization;
    s.provider.organizationMembers = async () => { s.config.teamOrganization = 'other-org'; return ['alice']; };
    const r = s.runtime();
    const job = await r.invoke('analyze', { repo: 'fixture/repo', number: 1, requestId: 'changed-org' }, s.caller('requester')) as any;
    const result = await r.invoke('submit', { id: job.id, analysis: s.analysis }, s.caller()) as any;
    assert.ok(result.analysis);
    assert.deepEqual(s.writes, []); assert.deepEqual(s.dispatches, []);
    assert.match(result.assignment.reason, /组织|Organization/);
  }
});
