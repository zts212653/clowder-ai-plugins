import assert from 'node:assert/strict';
import test from 'node:test';

import { LarkApiError, LarkCliExecutor, LarkCliProtocolError } from './LarkCliExecutor.js';
import { WeComApiError, WeComCliExecutor } from './WeComCliExecutor.js';
import type { EnterpriseLogger } from './logger.js';

const noop = () => undefined;
const logger: EnterpriseLogger = { debug: noop, info: noop, warn: noop, error: noop };

test('WeCom executor uses the configured executable and preserves API errors', async () => {
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  const executor = new WeComCliExecutor(logger, '/opt/tools/wecom-cli', 1234, async (executable, args) => {
    calls.push({ executable, args });
    if (args[0] === '--version') return { stdout: '1.2.3\n', stderr: '' };
    return { stdout: JSON.stringify({ errcode: 40001, errmsg: 'invalid token' }), stderr: '' };
  });
  await assert.rejects(
    executor.exec('doc', 'create_doc', { doc_name: 'PRD' }),
    (error) => error instanceof WeComApiError && error.errcode === 40001,
  );
  assert.deepEqual(calls, [
    { executable: '/opt/tools/wecom-cli', args: ['--version'] },
    { executable: '/opt/tools/wecom-cli', args: ['doc', 'create_doc', '{"doc_name":"PRD"}'] },
  ]);
});

test('Lark executor uses the configured executable and exact cobra flags', async () => {
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  const executor = new LarkCliExecutor(logger, '/opt/tools/lark-cli', 1234, async (executable, args) => {
    calls.push({ executable, args });
    if (args[0] === '--version') return { stdout: '1.2.3\n', stderr: '' };
    return { stdout: JSON.stringify({ ok: true, data: { guid: 'T1' } }), stderr: '' };
  });
  const result = await executor.exec('task', '+create', {
    summary: 'Ship it',
    completed: true,
    omitted: false,
    empty: undefined,
  });
  assert.deepEqual(result, { ok: true, data: { guid: 'T1' } });
  assert.deepEqual(calls, [
    { executable: '/opt/tools/lark-cli', args: ['--version'] },
    {
      executable: '/opt/tools/lark-cli',
      args: ['task', '+create', '--summary', 'Ship it', '--completed'],
    },
  ]);
});

test('Lark executor distinguishes vendor and protocol failures', async () => {
  const responses = [
    JSON.stringify({ ok: false, error: { type: 'permission', code: 99991668, message: 'denied' } }),
    '<html>not-json</html>',
  ];
  const executor = new LarkCliExecutor(logger, 'lark-cli', 1234, async (_executable, args) => {
    if (args[0] === '--version') return { stdout: '1.2.3', stderr: '' };
    return { stdout: responses.shift()!, stderr: '' };
  });
  await assert.rejects(
    executor.exec('docs', '+create', { title: 'x' }),
    (error) => error instanceof LarkApiError && error.code === 99991668,
  );
  await assert.rejects(
    executor.exec('docs', '+create', { title: 'x' }),
    (error) => error instanceof LarkCliProtocolError && error.rawOutput === '<html>not-json</html>',
  );
});
