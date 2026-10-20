import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createConnection } from '../src/connections.mjs';

for (const value of [null, false, 0, []]) {
  test(`existing JSON ${JSON.stringify(value)} is invalid configuration, never a blank first use`, async () => {
    const folder = await mkdtemp(join(tmpdir(), 'repo-sync-config-shape-'));
    const file = join(folder, 'config.json');
    const text = JSON.stringify(value);
    await writeFile(file, text);
    await assert.rejects(() => createConnection(file), { code: 'CONFIGURATION_UNREADABLE' });
    assert.equal(await readFile(file, 'utf8'), text);
  });
}
