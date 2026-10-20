import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createConnection } from '../src/connections.mjs';
import { authenticationStatus, clearIssueTokens, setIssueToken } from '../src/issue-auth.mjs';
import { repositories } from './fixtures.mjs';

test('file-rule save changes only pending path rules, retains platform authentication, rejects stale or extra inputs', async () => {
  const f = await repositories(),
    folder = await mkdtemp(join(tmpdir(), 'repo-sync-paths-')),
    file = join(folder, 'config.json');
  await writeFile(
    file,
    JSON.stringify({
      ...f.config,
      configurationSource: 'workbench',
      internalWebUrl: 'https://codehub.example/team/core',
      pullRequests: {
        mode: 'gitlab',
        apiUrl: 'https://api.example/api/v4',
        projectId: 'team/core',
        authMode: 'session',
      },
    }),
  );
  const connection = await createConnection(file),
    previous = (await connection.current()).config,
    owner = Symbol();
  setIssueToken(previous, 'SYNTHETIC_TEST_TOKEN', owner);
  const input = {
    action: 'configure-file-rules',
    expectedRevision: connection.describe().revision,
    expectedBinding: previous.bindingId,
    internalPaths: ['README.md'],
  };
  try {
    await connection.run(input);
    const current = (await connection.current()).config;
    assert.deepEqual(current.pullRequests, previous.pullRequests);
    for (const key of ['sourceUrl', 'internalUrl', 'sourceBranch', 'targetBranch', 'mode', 'checks', 'internalWebUrl'])
      assert.deepEqual(current[key], previous[key]);
    assert.deepEqual(current.internalPaths, ['README.md']);
    assert.equal(authenticationStatus(current).available, true);
    assert.equal((await readFile(file, 'utf8')).includes('SYNTHETIC_TEST_TOKEN'), false);
    const before = await readFile(file, 'utf8');
    await assert.rejects(() => connection.run(input), { code: 'CONFIGURATION_CHANGED' });
    await assert.rejects(
      () =>
        connection.run({
          ...input,
          expectedRevision: connection.describe().revision,
          expectedBinding: current.bindingId,
          sourceUrl: 'https://github.com/other/core.git',
        }),
      { code: 'INVALID_CONFIGURATION_INPUT' },
    );
    assert.equal(await readFile(file, 'utf8'), before);
  } finally {
    clearIssueTokens(owner);
  }
});
test('an adopted baseline cannot change path rules through the file tree save action', async () => {
  const f = await repositories(),
    folder = await mkdtemp(join(tmpdir(), 'repo-sync-paths-')),
    file = join(folder, 'config.json');
  await writeFile(file, JSON.stringify({ ...f.config, configurationSource: 'workbench' }));
  const connection = await createConnection(file),
    receiver = await connection.current();
  await receiver.adopt(f.u0, f.i0);
  const before = await readFile(file, 'utf8');
  await assert.rejects(
    () =>
      connection.run({
        action: 'configure-file-rules',
        expectedRevision: connection.describe().revision,
        expectedBinding: receiver.config.bindingId,
        internalPaths: ['core.txt'],
      }),
    { code: 'CONFIGURATION_READ_ONLY' },
  );
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal((await receiver.status()).accepted.upstream, f.u0);
});
