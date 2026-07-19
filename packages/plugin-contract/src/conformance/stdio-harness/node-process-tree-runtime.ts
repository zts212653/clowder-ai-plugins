import { spawn } from 'node:child_process';

import {
  type ProcessTreeRuntime,
  type TaskkillOutcome,
} from './process-tree-controller.js';

export interface TaskkillProcess {
  readonly kill: () => boolean;
  readonly once: {
    (event: 'close', listener: (code: number | null) => void): TaskkillProcess;
    (event: 'error', listener: (error: Error) => void): TaskkillProcess;
  };
}

export type TaskkillSpawner = (
  command: string,
  args: readonly string[],
  options: { readonly stdio: 'ignore'; readonly windowsHide: true },
) => TaskkillProcess;

const defaultTaskkillSpawner: TaskkillSpawner = (command, args, options) =>
  spawn(command, [...args], options) as TaskkillProcess;

export function runTaskkill(
  rootPid: number,
  timeoutMs: number,
  spawnTaskkill: TaskkillSpawner = defaultTaskkillSpawner,
): Promise<TaskkillOutcome> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('taskkill timeoutMs must be a positive safe integer');
  }
  let child: TaskkillProcess;
  try {
    child = spawnTaskkill(
      'taskkill',
      ['/pid', String(rootPid), '/t', '/f'],
      { stdio: 'ignore', windowsHide: true },
    );
  } catch (error) {
    return Promise.resolve({
      status: 'spawn-error',
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: TaskkillOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      child.kill();
      settle({ status: 'timeout' });
    }, timeoutMs);
    child.once('error', (error) => settle({ status: 'spawn-error', error }));
    child.once('close', (code) =>
      settle(code === 0 ? { status: 'success' } : { status: 'nonzero', code }),
    );
  });
}

export function createNodeProcessTreeRuntime(
  platform: NodeJS.Platform,
  signalTarget: (signal: NodeJS.Signals) => void,
  killProcess: typeof process.kill = process.kill,
): ProcessTreeRuntime {
  return {
    platform,
    now: Date.now,
    sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    signalTarget,
    signalTree: (rootPid, signal) => {
      try {
        killProcess(-rootPid, signal);
      } catch (error) {
        if (isNoSuchProcessError(error)) {
          signalTarget(signal);
          return;
        }
        throw error;
      }
    },
    treeIsAlive: (rootPid) => {
      try {
        killProcess(platform === 'win32' ? rootPid : -rootPid, 0);
        return true;
      } catch (error) {
        if (isNoSuchProcessError(error)) {
          return false;
        }
        if (isPermissionError(error)) {
          return true;
        }
        throw error;
      }
    },
    runTaskkill,
  };
}

function isNoSuchProcessError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}

function isPermissionError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EPERM';
}
