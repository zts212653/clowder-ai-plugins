import { createInterface } from 'node:readline';
const mode = process.argv[2] ?? 'normal';
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ id, result })}\n`);
let heldStatus;
process.stdout.on('error', () => {});
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (mode === 'one-shot') { process.stdout.write(`${JSON.stringify({ id, result: { pid: process.pid } })}\n`, () => process.exit(0)); continue; }
  if (mode === 'malformed') { process.stdout.write('{"SENTINEL_PRIVATE_SECRET":\n'); continue; }
  if (mode === 'oversize') { process.stdout.write(`${'SENTINEL'.repeat(140000)}\n`); continue; }
  if (mode === 'secret-error') { process.stdout.write(`${JSON.stringify({ id, error: { code: 'SENTINEL_PRIVATE_SECRET' } })}\n`); continue; }
  if (method === 'hello') reply(id, { product: 'clowder-wechat-link', pid: process.pid, protocolVersion: 1 });
  else if (method === 'status' && mode === 'out-of-order') heldStatus = id;
  else if (method === 'status') reply(id, { connection: 'offline', authenticated: false });
  else if (params?.operationId === 'slow') setTimeout(() => reply(id, { operation: { id: 'slow', phase: 'pending' } }), 80);
  else {
    reply(id, { operation: { id: params.operationId, phase: 'pending' } });
    if (heldStatus) { reply(heldStatus, { connection: 'offline', authenticated: false }); heldStatus = null; }
  }
}
