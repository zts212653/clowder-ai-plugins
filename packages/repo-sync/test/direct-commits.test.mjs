import assert from 'node:assert/strict';
import test from 'node:test';
import { Receiver } from '../src/engine.mjs';
import { discover, groupLandings } from '../src/github.mjs';
import { closureEvidence, collectIssues } from '../src/github-issues.mjs';
import { repositories } from './fixtures.mjs';

test('unassociated main commits are automatic; ambiguous or missing metadata still stops', () => {
  assert.equal(groupLandings(['a'], { a: [] }, 'main')[0].kind, 'commit');
  assert.equal(groupLandings(['a'], { a: [] }, 'main', true)[0].kind, 'commit');
  const pr = { node_id: 'pr', merged_at: '2026-10-15', merge_commit_sha: 'a', base: { ref: 'main' } };
  assert.throws(() => groupLandings(['a'], { a: [pr, { ...pr, node_id: 'other' }] }, 'main', true), {
    code: 'SOURCE_UNPROVEN',
  });
  assert.throws(() => groupLandings(['a'], {}, 'main', true), { code: 'METADATA_INCOMPLETE' });
});
test('a direct commit cannot claim manual or unrelated closure events without a matching commit oid', () => {
  assert.deepEqual(
    closureEvidence(
      [
        { id: 'manual', closer: null },
        { id: 'other', closer: { oid: 'unrelated' } },
        { id: 'matching', closer: { oid: 'accepted' } },
      ],
      undefined,
      ['accepted'],
    ).map((event) => event.id),
    ['matching'],
  );
});

test('native direct-commit Issue lookup uses mentions and actual commit closure events, without inventing a PR', async (t) => {
  const old = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'SYNTHETIC_DIRECT_COMMIT_TOKEN';
  t.after(() => {
    if (old === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = old;
  });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname === '/graphql') {
      const { query, variables } = JSON.parse(options.body);
      assert.ok(query.includes('CLOSED_EVENT') && !query.includes('closingIssuesReferences'));
      assert.equal(variables.id, 'issue-71');
      return Response.json({
        data: {
          node: {
            timelineItems: {
              nodes: [
                { id: 'manual', closer: null },
                { id: 'actual', closer: { oid: 'landed' } },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    }
    assert.equal(url.pathname, '/repos/demo/core/issues/71');
    return Response.json({
      node_id: 'issue-71',
      number: 71,
      title: 'source Issue',
      html_url: 'https://github.com/demo/core/issues/71',
      body: 'source body',
    });
  });
  const issues = await collectIssues('demo/core', null, ['landed'], ['Fixes #71']);
  assert.equal(issues[0].relation, 'closes');
  assert.deepEqual(
    issues[0].evidence.map((item) => item.id),
    ['actual'],
  );
  assert.equal(calls.filter((path) => path === '/graphql').length, 1);
});
test('mixed PR and direct-commit deliveries preserve every source object and complete in main order across restart', async () => {
  const f = await repositories();
  const receiver = new Receiver({ ...f.config, sourceUrl: 'https://github.com/demo/core.git' });
  receiver.git.config = { ...receiver.config, sourceUrl: f.source };
  await receiver.adopt(f.u0, f.i0);
  const pr = {
    node_id: 'pr-1',
    number: 1,
    title: 'first PR',
    html_url: 'https://github.com/demo/core/pull/1',
    merged: true,
    merged_at: '2026-10-15',
    merge_commit_sha: f.u1,
    base: { ref: 'main' },
  };
  const provider = {
    api: async (path) =>
      path === 'repos/demo/core'
        ? { node_id: 'repo-1' }
        : path.includes('/commits/')
          ? path.includes(f.u1)
            ? [pr]
            : []
          : pr,
    collectIssues: async () => [],
  };
  await discover(receiver, { kind: 'latest' }, provider);
  let state = await receiver.status();
  assert.deepEqual(
    state.queue.map((plan) => plan.target),
    [f.u1, f.u2],
  );
  assert.equal(state.queue[1].source.kind, 'commit');
  assert.equal(state.queue[1].source.number, undefined);

  for (const [index, target] of [f.u1, f.u2].entries()) {
    await receiver.start();
    await receiver.prepare();
    state = await receiver.status();
    assert.ok(state.active.commits.includes(target));
    if (index === 1) {
      assert.match(state.templates.title, /主干提交/);
      assert.doesNotMatch(state.templates.title, /PR #undefined/);
    }
    await receiver.linkPr(`https://codehub.example/core/pull/${index + 1}`);
    await f.merge(state.active);
    await receiver.recover();
    await receiver.receipts([]);
  }
  const restored = await new Receiver(receiver.config).status();
  assert.equal(restored.accepted.upstream, f.u2);
  assert.equal(restored.deliveries.length, 2);
  assert.ok(restored.deliveries.every((delivery) => delivery.status === 'COMPLETE'));
  assert.deepEqual(restored.issues, {});
});
