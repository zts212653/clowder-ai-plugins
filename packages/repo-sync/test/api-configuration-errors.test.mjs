import assert from 'node:assert/strict';
import test from 'node:test';
import { safeError } from '../src/execution.mjs';
import { validateGitlabApi } from '../src/issue-adapter.mjs';
import { issueConfiguration } from '../src/issue-settings.mjs';

const valid = () => ({ apiUrl: 'https://api.example/api/v4', projectId: 'team/core', authMode: 'session' });
test('an Issue link alone infers the API and project; hidden shared settings retain the already configured API host', () => {
  const config = { internalWebUrl: 'https://web.example/team/core' };
  const inferred = issueConfiguration(config, {
    issueMode: 'gitlab',
    issuePageUrl: `${config.internalWebUrl}/issues`,
    issueAuthMode: 'session',
  });
  assert.equal(inferred.apiUrl, 'https://web.example/api/v4');
  assert.equal(inferred.projectId, 'team/core');
  const shared = { ...valid(), mode: 'gitlab' };
  const unchanged = issueConfiguration({ ...config, pullRequests: shared }, { issueMode: 'gitlab' });
  assert.deepEqual(unchanged, shared);
});
function rejected(value, field) {
  assert.throws(
    () => validateGitlabApi({}, value),
    (error) => {
      assert.equal(error.code, 'INVALID_ISSUE_CONFIG');
      assert.equal(safeError(error).details?.fields?.[0]?.field, field);
      assert.equal(JSON.stringify(safeError(error)).includes('PRIVATE_SECRET'), false);
      return true;
    },
  );
}
test('an API root accepts trailing slashes and encoded project paths without requiring an environment variable', () => {
  const value = { ...valid(), apiUrl: ' https://api.example/api/v4/ ', projectId: 'team%2Fcore' };
  validateGitlabApi({}, value);
  assert.equal(value.apiUrl, 'https://api.example/api/v4');
  assert.equal(value.projectId, 'team/core');
  assert.equal(value.tokenEnv, undefined);
  const legacy = { ...valid(), apiUrl: 'https://API.example/api/v4', projectId: 7 };
  const before = structuredClone(legacy);
  validateGitlabApi({}, legacy);
  assert.deepEqual(legacy, before);
});
test('the project path cannot be mistaken for an API URL and errors identify the actual field', () => {
  rejected({ ...valid(), apiUrl: 'team/core' }, 'issueApiUrl');
  rejected({ ...valid(), apiUrl: 'http://api.example/api/v4' }, 'issueApiUrl');
  rejected({ ...valid(), apiUrl: 'https://api.example/api/v4/projects/7/issues' }, 'issueApiUrl');
  rejected({ ...valid(), apiUrl: 'https://PRIVATE_SECRET@api.example/api/v4' }, 'issueApiUrl');
  rejected({ ...valid(), projectId: 'https://web.example/team/core' }, 'issueProjectId');
  rejected({ ...valid(), projectId: 'team%2F..%2Fcore' }, 'issueProjectId');
  rejected({ ...valid(), projectId: 'team%252Fcore' }, 'issueProjectId');
  rejected({ ...valid(), authMode: 'invalid' }, 'issueAuthMode');
  rejected({ ...valid(), authMode: 'environment', tokenEnv: '$PRIVATE_SECRET' }, 'issueTokenEnv');
});
test('all invalid API fields are returned together, without input values or arbitrary diagnostic text', () => {
  let error;
  try {
    validateGitlabApi({}, { apiUrl: 'team/core', projectId: '', authMode: 'environment', tokenEnv: '' });
  } catch (caught) {
    error = caught;
  }
  assert.deepEqual(
    safeError(error).details?.fields.map((item) => item.field),
    ['issueApiUrl', 'issueProjectId', 'issueTokenEnv'],
  );
  const injected = {
    ...error,
    details: {
      fields: [
        null,
        'PRIVATE_SECRET',
        { field: 'issueApiUrl', reason: 'url', message: 'PRIVATE_SECRET', value: 'PRIVATE_SECRET' },
        { field: 'issueToken', reason: 'url', message: 'PRIVATE_SECRET' },
        { field: 'issueApiUrl', reason: 'PRIVATE_SECRET' },
      ],
    },
  };
  const visible = safeError(injected);
  assert.equal(visible.details.fields.length, 1);
  assert.equal(JSON.stringify(visible).includes('PRIVATE_SECRET'), false);
});
test('invalid Issue links distinguish the page field from the repository homepage', () => {
  const config = { internalWebUrl: 'https://web.example/team/core' };
  for (const page of ['https://web.example/other/core/issues', 'bad-link']) {
    assert.throws(
      () => issueConfiguration(config, { issueMode: 'gitlab', issuePageUrl: page, issueAuthMode: 'session' }),
      (error) => {
        assert.equal(safeError(error).details?.fields?.[0]?.field, 'issuePageUrl');
        return true;
      },
    );
  }
  assert.throws(
    () =>
      issueConfiguration(
        {},
        { issueMode: 'gitlab', issuePageUrl: 'https://web.example/team/core/issues', issueAuthMode: 'session' },
      ),
    (error) => {
      assert.equal(safeError(error).details?.fields?.[0]?.field, 'internalWebUrl');
      return true;
    },
  );
});
