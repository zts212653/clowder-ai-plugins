import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { configuredReceiver } from '../src/settings.mjs';
import { Store } from '../src/store.mjs';

for (const value of [null, false, 0, []]) {
  test(`existing ledger ${JSON.stringify(value)} is corruption, not an absent baseline`, async () => {
    const folder = await mkdtemp(join(tmpdir(), 'repo-sync-ledger-shape-'));
    const store = new Store(folder);
    const text = JSON.stringify(value);
    await writeFile(store.path, text);
    await assert.rejects(() => store.read(), { code: 'LEDGER_UNREADABLE' });
    assert.equal(await readFile(store.path, 'utf8'), text);
  });
  test(`existing settings ${JSON.stringify(value)} cannot silently restore default file rules`, async () => {
    const folder = await mkdtemp(join(tmpdir(), 'repo-sync-settings-shape-'));
    const file = join(folder, 'sync-settings.json');
    const text = JSON.stringify(value);
    await writeFile(file, text);
    const config = {
      sourceUrl: 'https://github.com/example/core.git',
      internalUrl: 'git@codehub.example:team/core.git',
      stateDir: folder,
      sourceBranch: 'main',
      targetBranch: 'main',
      checks: [{ command: 'git', args: ['fsck', '--no-reflogs'] }],
    };
    await assert.rejects(() => configuredReceiver(config), { code: 'SETTINGS_UNREADABLE' });
    assert.equal(await readFile(file, 'utf8'), text);
  });
}
