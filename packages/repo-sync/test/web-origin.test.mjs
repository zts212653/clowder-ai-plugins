import assert from 'node:assert/strict';
import test from 'node:test';
import { checkFrozenPr } from '../src/pr-settings.mjs';
import { prUrl } from '../src/pull-requests.mjs';
import { prPanel } from '../web/pr.mjs';

const config = { internalUrl: 'ssh://git@ssh.codehub.example:2222/team/core.git' };
test('SSH clone host and port are never treated as the web repository', () => {
  for (const kind of ['PR', 'Issue'])
    assert.throws(() => prUrl(config, 'https://web.codehub.example/team/core/merge_requests/501', kind), {
      code: 'INTERNAL_WEB_URL_REQUIRED',
      safeToDisplay: true,
    });
  const configured = { ...config, internalWebUrl: 'https://web.codehub.example/team/core' };
  assert.equal(
    prUrl(configured, 'https://web.codehub.example/team/core/merge_requests/501'),
    'https://web.codehub.example/team/core/merge_requests/501',
  );
  for (const url of [
    configured.internalWebUrl,
    'https://ssh.codehub.example:2222/team/core/merge_requests/501',
    'https://web.codehub.example/team/other/merge_requests/501',
    'https://web.codehub.example/team/core-other/merge_requests/501',
  ])
    assert.throws(() => prUrl(configured, url), { code: 'PR_URL_MISMATCH' });
});

test('a missing web origin can be added to a matching manual reference without changing creation intent', () => {
  const active = { prUrl: 'https://web.codehub.example/team/core/merge_requests/501' };
  const next = { ...config, internalWebUrl: 'https://web.codehub.example/team/core' };
  assert.doesNotThrow(() => checkFrozenPr(active, config, next));
  assert.throws(() => checkFrozenPr(active, config, { ...next, internalWebUrl: 'https://wrong.example/team/core' }), {
    code: 'PR_URL_MISMATCH',
  });
  assert.throws(() => checkFrozenPr({ ...active, gitPr: { status: 'INTENT_SAVED' } }, config, next), {
    code: 'PR_CONFIG_FROZEN',
  });
});

test('missing web repository has a configuration form at the PR step', () => {
  const html = prPanel(
    {
      config,
      connection: { revision: 'current-revision' },
      platform: { transport: 'manual', prMode: 'manual', repositoryUrl: null },
      state: {
        active: { id: 'a'.repeat(24), status: 'PR_REQUIRED', branch: 'sync/test', candidate: 'b'.repeat(40) },
        templates: { title: 'sync', body: 'synthetic' },
      },
    },
    String,
  );
  assert.match(html, /data-form="configure-pr"/);
  assert.match(html, /SSH/);
  assert.doesNotMatch(html, /data-form="pr"/);
});
