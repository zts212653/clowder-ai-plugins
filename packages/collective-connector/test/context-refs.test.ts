import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as module from '../src/collective-context-refs.js';
type Identity = { invocationId: string; pluginInstanceId: string };
type References = { opaqueRef(auth: Identity, operation: string, scope: string): string; verifyRef(auth: Identity, actual: string, operation: string, scope: string): void };
const open = (module as unknown as { openCollectiveContextReferences?: (directory: string, assertActive: () => void) => Promise<References> }).openCollectiveContextReferences;
const auth = { invocationId: 'invocation', pluginInstanceId: 'instance' };
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'collective-refs-')); t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(typeof open, 'function', 'Missing package-private persistent key adapter');
  return { directory, refs: await open!(directory, () => {}) };
}
test('business reference uses the persistent private key with instance/invocation/operation/scope tuple', async t => {
  const { directory, refs } = await fixture(t);
  const key = (await readFile(join(directory, 'native-reference.secret'), 'utf8')).trim();
  const expected = createHmac('sha256', key).update(JSON.stringify(['instance', 'invocation', 'context', 'message:origin'])).digest('base64url');
  const actual = refs.opaqueRef(auth, 'context', 'message:origin'); assert.equal(actual, expected); refs.verifyRef(auth, actual, 'context', 'message:origin');
  assert.equal((await stat(join(directory, 'native-reference.secret'))).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(refs), '{}'); assert.deepEqual(Object.keys(refs).sort(), ['opaqueRef', 'verifyRef']);
});
test('reference rejects another instance/invocation/operation/scope and tampered or wrong-length values', async t => {
  const { refs } = await fixture(t); const value = refs.opaqueRef(auth, 'reply:outbox', 'source:work:1');
  for (const [identity, operation, scope] of [[{ ...auth, pluginInstanceId: 'other' }, 'reply:outbox', 'source:work:1'],
    [{ ...auth, invocationId: 'other' }, 'reply:outbox', 'source:work:1'], [auth, 'return', 'source:work:1'], [auth, 'reply:outbox', 'source:work:2']] as const) {
    assert.throws(() => refs.verifyRef(identity, value, operation, scope), error => (error as { code?: string }).code === 'RETURN_REF_INVALID');
  }
  for (const invalid of ['', value.slice(1), 'x'.repeat(value.length), value + 'x'])
    assert.throws(() => refs.verifyRef(auth, invalid, 'reply:outbox', 'source:work:1'), /current invocation and source/);
});
test('private key survives restart and concurrent initialization publishes a single whole winner', async t => {
  const { directory, refs } = await fixture(t); const value = refs.opaqueRef(auth, 'context', 'message:1');
  const reopened = await open!(directory, () => {}); assert.equal(reopened.opaqueRef(auth, 'context', 'message:1'), value);
  const other = await mkdtemp(join(tmpdir(), 'collective-refs-race-')); t.after(() => rm(other, { recursive: true, force: true }));
  const all = await Promise.all(Array.from({ length: 16 }, () => open!(other, () => {})));
  assert.equal(new Set(all.map(refs => refs.opaqueRef(auth, 'context', 'message:1'))).size, 1);
});
test('separate private data roots never share a key even with the same identity tuple', async t => {
  const first = await fixture(t), second = await fixture(t);
  assert.notEqual(first.refs.opaqueRef(auth, 'context', 'message:1'), second.refs.opaqueRef(auth, 'context', 'message:1'));
});
test('corrupt existing key refuses without silently replacing durable bytes', async t => {
  const { directory } = await fixture(t); const path = join(directory, 'native-reference.secret');
  for (const value of ['', 'wrong', 'A'.repeat(44), 'A'.repeat(42) + '!']) {
    await writeFile(path, value, { mode: 0o600 });
    await assert.rejects(open!(directory, () => {}), /reference key/); assert.equal(await readFile(path, 'utf8'), value);
  }
});
test('revoked feature rejects key opening and references without exposing or initializing a key', async t => {
  const { directory, refs } = await fixture(t); let active = true;
  const fenced = await open!(directory, () => { if (!active) throw new Error('feature stopped'); }); active = false;
  assert.throws(() => fenced.opaqueRef(auth, 'context', 'message:1'), /feature stopped/);
  const value = refs.opaqueRef(auth, 'context', 'message:1'); assert.throws(() => fenced.verifyRef(auth, value, 'context', 'message:1'), /feature stopped/);
  const missing = join(directory, 'never-created'); await assert.rejects(open!(missing, () => { throw new Error('feature stopped'); }), /feature stopped/);
  await assert.rejects(stat(missing), { code: 'ENOENT' });
});
test('preexisting FIFO key refuses promptly without a writer, replacement or hung process', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'collective-refs-fifo-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'native-reference.secret');
  const fifo = spawnSync('mkfifo', ['-m', '600', path], { encoding: 'utf8' }); assert.equal(fifo.status, 0, fifo.stderr);
  const script = join(directory, 'probe.mjs');
  const source = new URL('../src/collective-context-refs.ts', import.meta.url);
  await writeFile(script, `import {openCollectiveContextReferences} from ${JSON.stringify(source.href)};
console.log('KEY_OPEN_STARTED');
try { await openCollectiveContextReferences(${JSON.stringify(directory)},()=>{}); process.exitCode=2; }
catch(error) { if (!/reference key is invalid/.test(error.message)) throw error; console.log('FIFO_REFUSED'); }
`);
  // A blocking libuv open cannot be reliably retired by an in-process Promise timeout.
  // Bound the owned probe process, including on the original RED implementation.
  const probe = spawnSync(process.execPath, ['--import', 'tsx', script], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 4000, killSignal: 'SIGKILL',
  });
  assert.match(probe.stdout, /KEY_OPEN_STARTED/);
  assert.equal(probe.error, undefined, 'FIFO key open must settle before the owned probe deadline');
  assert.equal(probe.status, 0, probe.stderr); assert.match(probe.stdout, /FIFO_REFUSED/);
  assert.equal((await stat(path)).isFIFO(), true);
});
