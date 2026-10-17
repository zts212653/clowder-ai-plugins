import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { dispatch } from '../src/actions.mjs';
import { validateConfig } from '../src/config.mjs';
import { configuredReceiver } from '../src/settings.mjs';
import { configuration } from '../web/connections.mjs';
import { esc } from '../web/ui.mjs';
import { modeSettings } from '../web/version.mjs';

test('both modes reject shared-file merge policies, while legacy empty arrays keep their binding identity', () => {
  const base = {
    sourceUrl: 'https://github.com/example/core.git',
    internalUrl: 'git@codehub.example:team/core.git',
    sourceBranch: 'main',
    targetBranch: 'main',
    stateDir: join(tmpdir(), 'strict-policy'),
  };
  for (const mode of ['version', 'continuous']) {
    assert.throws(() => validateConfig({ ...base, mode, mergePaths: ['README.md'] }), {
      code: 'UNSUPPORTED_MERGE_POLICY',
    });
    assert.equal(
      validateConfig({ ...base, mode }).bindingId,
      validateConfig({ ...base, mode, mergePaths: [] }).bindingId,
    );
    const c = validateConfig({ ...base, mode });
    assert.equal(
      configuration(
        { config: c, connection: { editable: true }, state: null },
        esc,
        (s) => s,
        () => '',
      ).includes('name="mergePaths"'),
      false,
    );
    assert.equal(modeSettings(c, null, esc).includes('name="mergePaths"'), false);
  }
});
test('old shared-file settings stop explicitly and preserve the stored configuration and ledger bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'repo-sync-old-policy-'));
  const settings = join(dir, 'sync-settings.json'),
    ledger = join(dir, 'ledger.json');
  await writeFile(
    settings,
    JSON.stringify({ schema: 1, mode: 'version', internalPaths: [], mergePaths: ['README.md'] }),
  );
  await writeFile(ledger, 'PRIVATE_EXISTING_RECORD');
  const before = await readFile(settings, 'utf8');
  await assert.rejects(
    () =>
      configuredReceiver({
        allowLocal: true,
        sourceUrl: 'https://github.com/example/core.git',
        internalUrl: 'git@codehub.example:team/core.git',
        sourceBranch: 'main',
        targetBranch: 'main',
        stateDir: dir,
      }),
    { code: 'UNSUPPORTED_MERGE_POLICY' },
  );
  assert.equal(await readFile(settings, 'utf8'), before);
  assert.equal(await readFile(ledger, 'utf8'), 'PRIVATE_EXISTING_RECORD');
});
test('removed conflict editing actions cannot write or create a candidate', async () => {
  for (const action of ['conflict', 'resolve'])
    await assert.rejects(() => dispatch({}, { action }), { code: 'UNKNOWN_ACTION' });
});
