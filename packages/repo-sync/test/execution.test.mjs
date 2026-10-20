import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatch } from '../src/actions.mjs';
import { safeError } from '../src/execution.mjs';
import { command, gitEnvironment } from '../src/process.mjs';

test('connection check reads advertised heads without fetching or creating an object store', async () => {
  const heads = { upstream: 'a'.repeat(40), internal: 'b'.repeat(40) };
  const receiver = {
    git: {
      heads: async () => heads,
      fetch: async () => {
        throw new Error('unexpected object download');
      },
    },
    store: { locked: (operation) => operation() },
  };
  assert.deepEqual(await dispatch(receiver, { action: 'heads' }, {}), heads);
});
test('SSH host-key failure gives a safe actionable reason instead of opaque exit 128', async () => {
  await assert.rejects(
    command(process.execPath, [
      '-e',
      'process.stderr.write("Host key verification failed. private-host/token=fixture-secret\\n");process.exit(128)',
    ]),
    (error) => {
      assert.equal(error.code, 'SSH_HOST_KEY_FAILED');
      assert.match(error.message, /主机密钥/);
      assert.doesNotMatch(
        JSON.stringify({ code: error.code, message: error.message, details: error.details }),
        /private-host|fixture-secret/,
      );
      return true;
    },
  );
});
test('cancel and timeout have separate safe error codes', async () => {
  // Keep the worker alive until killed; natural exit races taskkill under a loaded full suite.
  await assert.rejects(command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 50 }), {
    code: 'COMMAND_TIMEOUT',
  });
  const controller = new AbortController();
  const running = command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  controller.abort();
  await assert.rejects(running, { code: 'OPERATION_CANCELLED' });
});
test('diagnostic categories preserve useful reasons without exposing provider output', async () => {
  for (const [text, code] of [
    ['REMOTE HOST IDENTIFICATION HAS CHANGED! Host key verification failed.', 'SSH_HOST_KEY_CHANGED'],
    ['Permission denied (publickey).', 'SSH_AUTH_FAILED'],
    ['Authentication failed', 'HTTPS_AUTH_FAILED'],
    ['Could not resolve hostname private-host', 'NETWORK_FAILED'],
    ['repository not found', 'REPOSITORY_UNAVAILABLE'],
  ])
    await assert.rejects(
      command(process.execPath, [
        '-e',
        `process.stderr.write(${JSON.stringify(`${text} fixture-secret`)});process.exit(128)`,
      ]),
      (error) => {
        assert.equal(error.code, code);
        assert.doesNotMatch(JSON.stringify(safeError(error)), /private-host|fixture-secret/);
        return true;
      },
    );
  const error = Object.assign(new Error('private-file fixture-secret'), { code: 'EACCES' });
  assert.doesNotMatch(JSON.stringify(safeError(error)), /private-file|fixture-secret/);
});
test('background Git uses noninteractive SSH defaults and preserves explicitly configured SSH transports', () => {
  const saved = { command: process.env.GIT_SSH_COMMAND, ssh: process.env.GIT_SSH };
  try {
    delete process.env.GIT_SSH_COMMAND;
    delete process.env.GIT_SSH;
    assert.match(gitEnvironment().GIT_SSH_COMMAND, /BatchMode=yes.*StrictHostKeyChecking=yes/);
    process.env.GIT_SSH_COMMAND = 'operator-configured-ssh';
    assert.equal(gitEnvironment().GIT_SSH_COMMAND, 'operator-configured-ssh');
  } finally {
    if (saved.command === undefined) delete process.env.GIT_SSH_COMMAND;
    else process.env.GIT_SSH_COMMAND = saved.command;
    if (saved.ssh === undefined) delete process.env.GIT_SSH;
    else process.env.GIT_SSH = saved.ssh;
  }
});
