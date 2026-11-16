import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadBundled, nativeAsset } from '../src/native-supervisor.mjs';

test('the actual shipped executable rejects DYLD injection before any Keychain is opened', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'wechat-artifact-injection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, 'clowder-wechat-link'), source = join(root, 'canary.c'), library = join(root, 'canary.dylib');
  await writeFile(binary, await loadBundled(nativeAsset(), new AbortController().signal), { mode: 0o700 });
  await writeFile(source, '#include <unistd.h>\n__attribute__((constructor)) static void canary(void) { write(2, "CLOWDER_INJECTION_CANARY", 24); }\n');
  execFileSync('/usr/bin/clang', ['-dynamiclib', '-o', library, source], { stdio: 'pipe' });
  const result = spawnSync(binary, [], { input: '{"id":1,"method":"hello"}\n', encoding: 'utf8', timeout: 10000,
    env: { DYLD_INSERT_LIBRARIES: library }, stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stderr, /CLOWDER_INJECTION_CANARY/, 'untrusted code ran inside the Keychain-bound executable');
  const hello = JSON.parse(result.stdout.trim()).result;
  assert.equal(hello.nativeApiAvailable, false);
  for (const mode of ['reauthorize', 'recover-initialization']) {
    const repair = spawnSync(binary, ['--data-dir', join(root, 'no-existing-state'), `--${mode}`], { encoding: 'utf8', timeout: 10000, env: {} });
    assert.equal(repair.status, 0);
    assert.equal(repair.stderr, '');
    const report = JSON.parse(repair.stdout);
    assert.equal(report.state, 'invalid_state');
    assert.equal(report.product, 'clowder-wechat-link');
    assert.equal(Object.keys(report).length, 5);
  }
  const signing = spawnSync('/usr/bin/codesign', ['-dvv', binary], { encoding: 'utf8' });
  assert.equal(signing.status, 0);
  assert.match(signing.stderr, /flags=0x[0-9a-f]+\([^\n]*runtime/);
});
