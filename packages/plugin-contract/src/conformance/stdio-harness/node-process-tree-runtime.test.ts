import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createNodeProcessTreeRuntime,
  runTaskkill,
  type TaskkillProcess,
  type TaskkillSpawner,
} from './node-process-tree-runtime.js';

interface FakeTaskkillProcess extends TaskkillProcess {
  readonly emitClose: (code: number | null) => void;
  readonly emitError: (error: Error) => void;
  readonly killed: () => boolean;
}

function createFakeTaskkillProcess(): FakeTaskkillProcess {
  let killed = false;
  let closeListener: ((code: number | null) => void) | undefined;
  let errorListener: ((error: Error) => void) | undefined;
  const child: FakeTaskkillProcess = {
    once: ((event: 'close' | 'error', listener: (value: never) => void) => {
      if (event === 'close') {
        closeListener = listener as (code: number | null) => void;
      } else {
        errorListener = listener as (error: Error) => void;
      }
      return child;
    }) as FakeTaskkillProcess['once'],
    emitClose: (code) => closeListener?.(code),
    emitError: (error) => errorListener?.(error),
    kill: () => {
      killed = true;
      return true;
    },
    killed: () => killed,
  };
  return child;
}

function spawnerFor(
  child: FakeTaskkillProcess,
  calls: Array<{ command: string; args: readonly string[] }>,
): TaskkillSpawner {
  return (command, args) => {
    calls.push({ command, args });
    return child;
  };
}

test('reports a nonzero taskkill close status instead of treating spawn as success', async () => {
  const child = createFakeTaskkillProcess();
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const result = runTaskkill(73, 100, spawnerFor(child, calls));
  queueMicrotask(() => child.emitClose(128));

  assert.deepEqual(await result, { status: 'nonzero', code: 128 });
  assert.deepEqual(calls, [
    { command: 'taskkill', args: ['/pid', '73', '/t', '/f'] },
  ]);
});

test('reports taskkill spawn errors as a terminal utility outcome', async () => {
  const child = createFakeTaskkillProcess();
  const failure = new Error('taskkill missing');
  const result = runTaskkill(73, 100, () => child);
  queueMicrotask(() => child.emitError(failure));

  assert.deepEqual(await result, { status: 'spawn-error', error: failure });
});

test('bounds a taskkill invocation that never emits error or close', async () => {
  const child = createFakeTaskkillProcess();

  assert.deepEqual(await runTaskkill(73, 5, () => child), { status: 'timeout' });
  assert.equal(child.killed(), true);
});

test('treats a POSIX EPERM existence probe as still alive', () => {
  const permissionError = Object.assign(new Error('not signalable yet'), {
    code: 'EPERM',
  });
  const runtime = createNodeProcessTreeRuntime('darwin', () => {}, () => {
    throw permissionError;
  });

  assert.equal(runtime.treeIsAlive(73), true);
});
