import assert from 'node:assert/strict';
import test from 'node:test';
import { captureDraft, configuration } from '../web/connections.mjs';
import { issueFields } from '../web/issue-settings.mjs';
import { setupConfiguration } from '../web/setup-view.mjs';
import { esc } from '../web/ui.mjs';

test('connection groups source branch with source and target branch with target, with upfront source authentication and commit identity', () => {
  const html = configuration({ config: null, state: null, connection: { revision: null } }, esc);
  const source = html.match(/<fieldset[^>]*data-repository="source"[^>]*>(.*?)<\/fieldset>/s)?.[1];
  const target = html.match(/<fieldset[^>]*data-repository="internal"[^>]*>(.*?)<\/fieldset>/s)?.[1];
  assert.ok(source?.includes('name="sourceUrl"') && source.includes('name="sourceBranch"'));
  assert.ok(
    target?.includes('name="internalUrl"') &&
      target.includes('name="targetBranch"') &&
      target.includes('name="internalWebUrl"'),
  );
  assert.ok(html.includes('name="commitClosureVerified"'));
  assert.ok(html.includes('data-connection-auth'));
  assert.ok(html.includes('name="githubToken"'));
  assert.ok(html.indexOf('data-connection-auth') < html.indexOf('name="githubToken"'));
  assert.ok(html.includes('data-next-auth'));
  assert.ok(html.includes('name="commitStrategy"'));
});

test('manual Issue configuration hides platform-specific fields; direct Token input is available for supported APIs', () => {
  const html = issueFields(null, esc);
  assert.match(html, /data-issue-api hidden/);
  const automatic = issueFields({ issueAutomation: { mode: 'gitlab' } }, esc);
  assert.match(automatic, /type="password"[^>]*name="issueToken"/);
  assert.ok(automatic.includes('Issue 网页链接'));
});

test('version setup starts without a visible internal API Token requirement', () => {
  const html = setupConfiguration({ config: null, state: null, connection: { revision: null } }, esc, () => '', () => '', {});
  assert.match(html, /data-issue-api hidden/);
  assert.match(html, /data-issue-selection hidden/);
});

test('password inputs never enter the browser configuration draft', () => {
  const previous = globalThis.document;
  const fields = [
    { name: 'sourceUrl', value: 'https://github.com/demo/core.git', type: 'url' },
    { name: 'issueToken', value: 'PRIVATE_DRAFT_SECRET', type: 'password' },
    { name: 'confirmed', value: 'on', type: 'checkbox', checked: true },
  ];
  globalThis.document = {
    querySelectorAll: () => [
      {
        dataset: { form: 'configure-repositories' },
        closest: () => null,
        elements: Object.assign(fields, { namedItem: () => null }),
      },
    ],
  };
  try {
    assert.equal(JSON.stringify(captureDraft()).includes('PRIVATE_DRAFT_SECRET'), false);
    assert.equal(JSON.stringify(captureDraft()).includes('confirmed'), false, 'action consent cannot be restored from browser storage');
  } finally {
    globalThis.document = previous;
  }
});
