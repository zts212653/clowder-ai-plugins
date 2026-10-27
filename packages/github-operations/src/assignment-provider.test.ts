import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubAssignmentProvider } from './assignment-provider.js';

function fixture() {
  const args: string[][] = [];
  const state = { assigned: true, failPage: false, pages: 1, login: 'Owner', otherAssignees: [] as string[], changed: false, issueReads: 0 };
  const issue = () => ({ id: 1, node_id: 'I_1', number: 1, title: 'original issue', state: 'open', updated_at: state.changed && state.issueReads > 1 ? 'later' : 'original', assignees: [...(state.assigned ? [state.login] : []), ...state.otherAssignees].map(login => ({ login })) });
  const provider = new GitHubAssignmentProvider({ token: async () => undefined, execFileAsync: async (_file, input) => {
    args.push(input);
    const path = input[1]; let result: unknown;
    if (path === 'user' || path === '/user') result = { login: state.login };
    else if (path.includes('/timeline')) result = [{ id: 98, event: 'assigned', assignee: { login: state.login } }, { id: 99, event: 'unassigned', assignee: { login: state.login } }, { id: 100, event: 'assigned', assignee: { login: state.login } }, ...state.otherAssignees.map((login, i) => ({ id: 101 + i, event: 'assigned', assignee: { login } }))];
    else if (/\/issues\/1$/.test(path)) { state.issueReads++; result = issue(); }
    else if (path.includes('/issues?')) {
      const page = Number(new URL(path).searchParams.get('page'));
      if (page === 2 && state.failPage) throw new Error('second page failed');
      result = state.pages === 2 && page === 1 ? Array.from({ length: 100 }, (_, n) => ({ ...issue(), number: n + 1 })) : page <= state.pages ? [issue(), { ...issue(), number: 999, pull_request: {} }] : [];
    } else throw new Error(`Unexpected request ${path}`);
    return { stdout: Array.isArray(result) ? result.map(r => JSON.stringify(r)).join('\n') : JSON.stringify(result) };
  } });
  return { provider, state, args };
}

test('real gh reader binds identity, excludes PRs, and reads latest native assignment epoch', async () => {
  const f = fixture(), signal = new AbortController().signal;
  assert.equal(await f.provider.identity(signal), 'owner');
  assert.equal((await f.provider.assigned('Owner/Project', 'OWNER', signal)).length, 1);
  const current = await f.provider.current('Owner/Project', 1, 'OWNER', signal);
  assert.equal(current.assignmentId, '100'); assert.deepEqual(current.assignees, ['owner']);
  assert.equal(current.repo, 'owner/project');
  assert.ok(f.args.every(args => !args.includes('POST') && !args.includes('PATCH') && !args.includes('DELETE')));
});

test('complete assigned listing rejects failed later pages instead of returning a partial snapshot', async () => {
  const f = fixture(); f.state.pages = 2; f.state.failPage = true;
  await assert.rejects(f.provider.assigned('owner/project', 'owner', new AbortController().signal), /second page failed/);
});

for (const account of ['Alice_Acme', 'Owner']) {
  test(`assignment reads accept ${account} alongside another managed-user assignee`, async () => {
    const f = fixture(), signal = new AbortController().signal;
    f.state.login = account; f.state.otherAssignees = ['Octo_Admin'];
    const login = await f.provider.identity(signal);
    assert.equal(login, account.toLowerCase());
    const assigned = await f.provider.assigned('owner/project', login, signal);
    assert.deepEqual(assigned.map(issue => issue.assignees), [[login, 'octo_admin']]);
    const current = await f.provider.current('owner/project', 1, login, signal);
    assert.equal(current.assignmentId, '100');
    assert.deepEqual(current.assignees, [login, 'octo_admin']);
    f.state.assigned = false;
    assert.equal((await f.provider.current('owner/project', 1, login, signal)).assignmentId, null);
  });
}

test('changed issue during timeline read fails closed; unclaimed issues need no timeline', async () => {
  const f = fixture(), signal = new AbortController().signal; f.state.changed = true;
  await assert.rejects(f.provider.current('owner/project', 1, 'owner', signal), /changed/);
  f.state.changed = false; f.state.assigned = false; f.args.length = 0;
  assert.equal((await f.provider.current('owner/project', 1, 'owner', signal)).assignmentId, null);
  assert.equal(f.args.some(args => args[1].includes('/timeline')), false);
});

test('invalid repo/login and abort make no requests', async () => {
  const f = fixture(), c = new AbortController();
  await assert.rejects(f.provider.assigned('../project', 'owner', c.signal));
  await assert.rejects(f.provider.assigned('owner/project', 'evil?query', c.signal));
  c.abort(); await assert.rejects(f.provider.identity(c.signal)); assert.equal(f.args.length, 0);
});
