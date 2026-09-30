import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

for (const kind of ['failed-with-interval', 'pending', 'clean']) {
  test(`test file deadline handles ${kind}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'connector-deadline-'));
    const file = join(dir, `${kind}.test.mjs`);
    const body = kind === 'clean' ? '' : kind === 'pending'
      ? 'setInterval(() => {}, 10); return new Promise(() => {});'
      : "setInterval(() => {}, 10); throw new Error('assertion failed');";
    try {
      await writeFile(file, `import test from 'node:test'; test('fixture', () => { ${body} });`);
      const env = { ...process.env, CLOWDER_TEST_FILE_TIMEOUT_MS: '200' };
      delete env.NODE_TEST_CONTEXT;
      env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import=${new URL('./test-file-deadline.mjs', import.meta.url).href}`;
      const result = spawnSync(process.execPath, [
        '--test', file,
      ], { encoding: 'utf8', env, timeout: 5000 });
      assert.equal(result.error, undefined, 'file must end before the external process watchdog');
      assert.equal(result.status, kind === 'clean' ? 0 : 1);
      const output = result.stdout + result.stderr;
      if (kind === 'clean') assert.doesNotMatch(output, /deadline exceeded/);
      else {
        assert.match(output, /Test file deadline exceeded/);
        assert.ok(output.includes(file), 'failure must identify the exact hung file');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
