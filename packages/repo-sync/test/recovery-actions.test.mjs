import assert from 'node:assert/strict';
import test from 'node:test';
import { errorGuide } from '../web/error-guide.mjs';
import { authenticationForm } from '../web/issue-auth.mjs';

test('missing or expired API tokens provide an immediate repair entry in the failing step', () => {
  for (const code of ['ISSUE_AUTH_REQUIRED', 'ISSUE_API_REJECTED', 'PR_API_REJECTED']) {
    assert.match(errorGuide({ code, message: '认证需要更新' }), /data-repair="platform"/);
  }
  assert.match(errorGuide({ code: 'GITHUB_AUTH_REQUIRED' }), /data-repair="github"/);
  assert.match(errorGuide({ code: 'TRANSFER_ACTIVATION_REQUIRED' }), /data-repair="transfer"/);
  assert.match(errorGuide({ code: 'SSH_AUTH_FAILED' }), /data-repair="connection"/);
  assert.doesNotMatch(errorGuide({ code: 'UNRELATED_FAILURE' }), /data-repair=/);
  assert.doesNotMatch(errorGuide({ code: 'ISSUE_AUTH_REQUIRED' }, { historical: true }), /data-repair=/);
});

test('authentication shows the exact API recipient before asking for a Token from an imported configuration', () => {
  const html = authenticationForm({
    platformApi: {
      mode: 'gitlab',
      apiUrl: 'https://separate-api.example/api/v4',
      projectId: 'team/core',
      authentication: { available: false },
    },
  });
  assert.ok(html.includes('https://separate-api.example/api/v4'));
  assert.ok(html.indexOf('https://separate-api.example/api/v4') < html.indexOf('type="password"'));
  assert.ok(html.includes('team/core'));
});
