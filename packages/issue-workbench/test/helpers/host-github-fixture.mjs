// Protocol fixture for the packed plugin's real gh subprocess. No network fallback.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.env.ISSUE_HOST_TEST_GITHUB;
assert.ok(file, 'This executable belongs only to the isolated Host integration test');
const state = JSON.parse(readFileSync(file, 'utf8'));
const actor = process.env.ISSUE_HOST_TEST_ACTOR ?? state.login;
const args = process.argv.slice(2);
assert.deepEqual(args.slice(0, 3), ['api', '--hostname', 'github.com']);
const url = new URL(args[3], 'https://api.github.com/');
const path = url.pathname;
const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET';
state.calls.push({ actor, path: path + url.search, method });
// Bounded diagnostic history only; user comments, Issues and receipts are never truncated.
if (state.calls.length > 2000) state.calls.splice(0, state.calls.length - 2000);
let result;
if (state.offline) throw new Error('Fixture GitHub offline');
if (path === '/user') result = { login: actor };
else if (path === '/user/memberships/orgs/fixture-org') result = { state: 'active', organization: { login: 'fixture-org' } };
else if (path === '/orgs/fixture-org/members') result = ['alice', 'bob'].map(login => ({ login, type: 'User' }));
else if (/^\/repos\/fixture\/repo\/assignees\/(alice|bob)$/.test(path)) result = {};
else if (/^\/repos\/fixture\/repo\/collaborators\/(alice|bob)\/permission$/.test(path)) result = { permission: 'write' };
else if (path === '/repos/fixture/repo/issues') result = state.issues.filter(issue => (url.searchParams.get('state') === 'all' || issue.state === 'open') &&
  (!url.searchParams.get('assignee') || issue.assignees.some(a => a.login === url.searchParams.get('assignee'))));
else if (path === '/repos/fixture/repo/issues/comments') result = [...state.comments].reverse();
else {
  const match = /^\/repos\/fixture\/repo\/issues\/(\d+)(\/comments|\/timeline|\/assignees)?$/.exec(path);
  assert.ok(match, 'Unexpected GitHub operation: ' + path);
  const issue = state.issues.find(issue => issue.number === Number(match[1]));
  assert.ok(issue, 'Unknown fixture issue');
  if (match[2] === '/comments') {
    if (method === 'POST') {
      const body = args.find(arg => arg.startsWith('body='))?.slice(5);
      assert.ok(body);
      const time = new Date().toISOString();
      const comment = { id: 100 + state.comments.length, body, user: { login: actor },
        created_at: time, updated_at: time, issue_url: 'https://api.github.com/repos/fixture/repo/issues/' + issue.number };
      state.comments.push(comment); result = comment;
    } else result = state.comments.filter(comment => comment.issue_url.endsWith('/' + issue.number));
  } else if (match[2] === '/timeline') result = (state.timeline ?? []).filter(event => event.number === issue.number);
  else if (match[2] === '/assignees' && method === 'POST') {
    const logins = args.filter(arg => arg.startsWith('assignees[]=' )).map(arg => arg.slice(12));
    assert.ok(logins.length && logins.every(login => ['alice', 'bob'].includes(login)), 'Fixture assignee must be a simulated member');
    state.timeline ??= [];
    for (const login of logins) if (!issue.assignees.some(a => a.login === login)) {
      issue.assignees.push({ login });
      state.timeline.push({ id: 1000 + state.timeline.length, number: issue.number, event: 'assigned', assignee: { login }, created_at: new Date().toISOString() });
    }
    result = issue;
  }
  else result = issue;
}
assert.ok(method === 'GET' || path.endsWith('/comments') || path.endsWith('/assignees'), 'Fixture forbids other writes');
writeFileSync(file, JSON.stringify(state));
process.stdout.write(JSON.stringify(args.includes('--slurp') ? [result] : result));
