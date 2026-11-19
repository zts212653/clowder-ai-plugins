import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { NativeStdioTransport } from '../src/native-stdio.mjs';
const fixture = new URL('./fixtures/native-stdio-peer.mjs', import.meta.url);
function channel(t, mode = 'normal') {
  const child = spawn(process.execPath, [fixture.pathname, mode], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  const transport = new NativeStdioTransport(child);
  t.after(async () => { transport.close(); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } });
  return { child, transport };
}
test('owned stdio correlates out-of-order real child responses and closes pending work', async t => {
  const { child, transport } = channel(t, 'out-of-order');
  const hello = await transport.request('hello');
  assert.equal(hello.pid, child.pid);
  const order = [];
  const status = transport.request('status').then(value => { order.push('status'); return value; });
  const operation = transport.request('login.operation', { operationId: 'fast' }).then(value => { order.push('operation'); return value; });
  assert.equal((await operation).operation.id, 'fast');
  assert.equal((await status).authenticated, false); assert.deepEqual(order, ['operation', 'status']);
  const pending = transport.request('login.operation', { operationId: 'slow' });
  transport.close(); await assert.rejects(pending, error => error.code === 'connection_closed');
});
test('a timed-out written request is uncertain, late replies never resolve a different request', async t => {
  const { transport } = channel(t); await transport.request('hello');
  await assert.rejects(transport.request('login.operation', { operationId: 'slow' }, { timeoutMs: 10 }), error => error.code === 'request_unknown');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await transport.request('login.operation', { operationId: 'next' })).operation.id, 'next');
  await assert.rejects(transport.request('status', { payload: 'x'.repeat(1024 * 1024) }), error => error.code === 'invalid_request');
  await assert.rejects(transport.request('account.export'), error => error.code === 'unsupported_method');
});
test('malformed, oversized and secret-bearing error responses fail without forwarding diagnostics', async t => {
  for (const mode of ['malformed', 'oversize', 'secret-error']) {
    const { transport } = channel(t, mode);
    await assert.rejects(transport.request('hello'), error => error.code === 'protocol_error' && !String(error).includes('SENTINEL'));
  }
});
test('local abort distinguishes an unwritten request from an uncertain written request', async t => {
  const { transport } = channel(t); await transport.request('hello');
  const before = new AbortController(); before.abort();
  await assert.rejects(transport.request('status', {}, { signal: before.signal }), error => error.code === 'request_cancelled' && !error.mayHaveCommitted);
  const during = new AbortController();
  const pending = transport.request('login.operation', { operationId: 'slow' }, { signal: during.signal });
  during.abort(); await assert.rejects(pending, error => error.code === 'request_unknown' && error.mayHaveCommitted);
  assert.equal((await transport.request('login.operation', { operationId: 'another' })).operation.id, 'another');
});
test('a child exit does not discard its final buffered response before stdout drains', async t => {
  const { child, transport } = channel(t, 'one-shot');
  child.stdout.pause();
  const outcome = transport.request('hello').then(value => value, error => error);
  await once(child, 'exit'); child.stdout.resume();
  assert.equal((await outcome).pid, child.pid);
});
