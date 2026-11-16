import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'UPSTREAM.json'), 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(manifest.upstreamCommit, 'ed976d78c1e1cc2a49ad17d1e2c0da023bbb5c8e');
const patch = join(root, 'protocol.patch');
assert.equal(digest(await readFile(patch)), manifest.patchSha256, 'protocol patch changed without provenance update');
const declared = new Set();
for (const file of manifest.files) {
  assert.match(file.path, /^(?:src\/[a-z_]+\.rs|fixtures\/(?:mmtls-public-keys\.json|business-public-keys\.json|LICENSE-CITIZENLAB)|LICENSE|NOTICE)$/);
  assert.ok(!declared.has(file.path), 'duplicate source identity'); declared.add(file.path);
  assert.equal(digest(await readFile(join(root, 'proto', file.path))), file.derivedSha256, `derived bytes changed: ${file.path}`);
}
for (const name of await readdir(join(root, 'proto/src'))) {
  assert.ok(declared.has(`src/${name}`), `untracked protocol source: ${name}`);
  if (name === 'transport.rs' || name.endsWith('_tests.rs')) continue;
  // A diagnostic source guard, not a proof of all possible Rust side effects.
  // Runtime constructors are centralized; retained wire tests may use loopback.
  const production = (await readFile(join(root, 'proto/src', name), 'utf8')).split(/#\[cfg\(test\)\]\s*mod tests\s*\{/)[0];
  assert.ok(!/TcpStream::connect|TcpListener::|UdpSocket::|reqwest::(?:blocking::)?Client::|std::process|Command::new|std::env::|std::fs::/.test(production), `network, process or storage construction outside transport: ${name}`);
}

// Supplying the exact public upstream tree additionally proves that applying
// the checked-in patch reconstructs every derived source byte. No downloads.
if (process.argv.length > 2) {
  assert.equal(process.argv.length, 3, 'usage: node verify-source.mjs [upstream-protocol-crate]');
  const upstream = resolve(process.argv[2]);
  const stage = await mkdtemp(join(tmpdir(), 'clowder-protocol-provenance-'));
  try {
    for (const file of manifest.files.filter(file => file.origin === 'upstream')) {
      const source = join(upstream, file.path);
      assert.equal(digest(await readFile(source)), file.upstreamSha256, `upstream source mismatch: ${file.path}`);
      await mkdir(dirname(join(stage, file.path)), { recursive: true });
      await cp(source, join(stage, file.path));
    }
    const result = spawnSync('git', ['apply', '--unidiff-zero', '--check', patch], {
      cwd: stage, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || 'patch check failed');
    const applied = spawnSync('git', ['apply', '--unidiff-zero', patch], {
      cwd: stage, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, encoding: 'utf8',
    });
    assert.equal(applied.status, 0, applied.stderr || 'patch application failed');
    for (const file of manifest.files) assert.equal(digest(await readFile(join(stage, file.path))), file.derivedSha256, `patch does not reconstruct ${file.path}`);
  } finally { await rm(stage, { recursive: true, force: true }); }
}
process.stdout.write(`${JSON.stringify({ sourceVerified: true, files: manifest.files.length, upstreamPatchReconstructed: process.argv.length === 3, officialKeyOriginVerified: false })}\n`);
