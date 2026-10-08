import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { before } from 'node:test';

const packageRoot = fileURLToPath(new URL('../packages/genoffice-docx/', import.meta.url));
// Script-only tests run before GenOffice's gate step on a clean checkout.
before(() => execFileSync('pnpm', ['--filter', '@clowder-ai/genoffice-docx', 'build'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'pipe', timeout: 60_000,
}));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, { cache, mode = 'offline', unsafe = false, wrongSourceDigest = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'genoffice-download-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(['scripts', 'dist', '.tmp', 'input/source'].map(dir => mkdir(join(root, dir), { recursive: true })));
  await cp(join(packageRoot, 'scripts'), join(root, 'scripts'), { recursive: true });
  await cp(join(packageRoot, 'dist/source-policy.js'), join(root, 'dist/source-policy.js'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'input/source/LICENSE'), 'fixture license');
  if (unsafe) {
    const { symlink } = await import('node:fs/promises');
    await symlink('/outside', join(root, 'input/source/escape'));
  }
  execFileSync('tar', ['-czf', join(root, 'good.tgz'), '-C', join(root, 'input'), 'source']);
  const archive = await readFile(join(root, 'good.tgz'));
  await writeFile(join(root, 'source-lock.json'), JSON.stringify({
    tag: 'fixture', rootDirectory: 'source', archiveUrl: 'https://source.invalid/archive',
    archiveSha256: digest(archive), commit: 'fixture',
    files: { LICENSE: digest(wrongSourceDigest ? 'different license' : 'fixture license') },
  }));
  if (cache) await writeFile(join(root, '.tmp/fixture.tar.gz'), cache === 'valid' ? archive : 'corrupt cache');
  await writeFile(join(root, 'mock.mjs'), `
import { readFileSync, appendFileSync } from 'node:fs';
let calls = 0;
globalThis.fetch = async (_url, { signal }) => {
  calls += 1; appendFileSync(${JSON.stringify(join(root, 'calls'))}, 'call\\n');
  const mode = ${JSON.stringify(mode)};
  if (mode === 'offline' || (mode === 'reset-once' && calls === 1)) {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('TLS disconnected before handshake'), { code: 'ECONNRESET' }) });
  }
  if (mode.startsWith('http-')) return new Response('', { status: Number(mode.slice(5)) });
  if (mode === 'tls-cert') throw Object.assign(new Error('certificate invalid'), { code: 'CERT_HAS_EXPIRED' });
  return new Response(mode === 'bad-digest' ? 'tampered' : readFileSync(${JSON.stringify(join(root, 'good.tgz'))}));
};`);
  const result = spawnSync(process.execPath, ['--import', join(root, 'mock.mjs'), join(root, 'scripts/fetch-verify-source.mjs')], { encoding: 'utf8', timeout: 5000 });
  const calls = await readFile(join(root, 'calls'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  return { root, archive, result, calls: calls.split('\n').filter(Boolean).length };
}
test('verified archive cache skips network but still extracts admitted source', async t => {
  const { root, result, calls } = await fixture(t, { cache: 'valid' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls, 0);
  assert.equal(await readFile(join(root, '.tmp/source/source/LICENSE'), 'utf8'), 'fixture license');
});
test('corrupt cached bytes are replaced only by a verified download', async t => {
  const { root, result, calls, archive } = await fixture(t, { cache: 'invalid', mode: 'success' });
  assert.equal(result.status, 0, result.stderr); assert.equal(calls, 1);
  assert.deepEqual(await readFile(join(root, '.tmp/fixture.tar.gz')), archive);
});
test('transient TLS reset retries then verifies the full archive', async t => {
  const { result, calls } = await fixture(t, { mode: 'reset-once' });
  assert.equal(result.status, 0, result.stderr); assert.equal(calls, 2);
});
test('persistent transport failure exhausts exactly three attempts', async t => {
  const { result, calls } = await fixture(t);
  assert.equal(result.status, 1); assert.equal(calls, 3); assert.match(result.stderr, /fetch failed/);
});
for (const status of [404, 429, 503]) test(`HTTP ${status} is terminal without retry`, async t => {
  const { result, calls } = await fixture(t, { mode: `http-${status}` });
  assert.equal(result.status, 1); assert.equal(calls, 1); assert.match(result.stderr, new RegExp(`HTTP ${status}`));
});
test('download digest mismatch is terminal and never replaces cache', async t => {
  const { root, result, calls } = await fixture(t, { cache: 'invalid', mode: 'bad-digest' });
  assert.equal(result.status, 1); assert.equal(calls, 1); assert.match(result.stderr, /digest mismatch/);
  assert.equal(await readFile(join(root, '.tmp/fixture.tar.gz'), 'utf8'), 'corrupt cache');
});
test('TLS certificate errors fail immediately', async t => {
  const { result, calls } = await fixture(t, { mode: 'tls-cert' });
  assert.equal(result.status, 1); assert.equal(calls, 1);
});
test('a matching cached digest cannot bypass archive admission', async t => {
  const { result, calls } = await fixture(t, { cache: 'valid', unsafe: true });
  assert.equal(result.status, 1); assert.equal(calls, 0); assert.match(result.stderr, /link entries are forbidden/);
});
test('a matching cached archive cannot bypass extracted-source admission', async t => {
  const { result, calls } = await fixture(t, { cache: 'valid', wrongSourceDigest: true });
  assert.equal(result.status, 1); assert.equal(calls, 0); assert.match(result.stderr, /locked source digest mismatch/);
});

test('download timeout covers headers and body, aborts each attempt, and stays bounded', async t => {
  const { readSourceArchive } = await import('../packages/genoffice-docx/scripts/source-archive.mjs');
  const root = await mkdtemp(join(tmpdir(), 'genoffice-timeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const phase of ['headers', 'body']) {
    let calls = 0; let aborted = 0; const delays = [];
    await assert.rejects(readSourceArchive(join(root, 'missing'), { archiveUrl: 'https://source.invalid' }, {
      timeoutMs: 5, sleep: async ms => { delays.push(ms); },
      fetchFn: async (_url, { signal }) => {
        calls += 1;
        const pending = () => new Promise((_, reject) => signal.addEventListener('abort', () => {
          aborted += 1; reject(signal.reason);
        }, { once: true }));
        if (phase === 'headers') return pending();
        return { ok: true, arrayBuffer: pending };
      },
    }), { name: 'TimeoutError' });
    assert.equal(calls, 3); assert.equal(aborted, 3); assert.deepEqual(delays, [250, 500]);
  }
});
