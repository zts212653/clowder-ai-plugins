import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { createNodeProcessTreeRuntime } from './node-process-tree-runtime.js';
import { type ProcessTreeRuntime } from './process-tree-controller.js';
import { spawnWindowsSentinel } from './windows-sentinel.js';

export interface SpawnHarnessChildOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface HarnessTargetLifecycle {
  readonly onTargetError: (listener: (error: Error) => void) => void;
  readonly onTargetExit: (
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ) => void;
  readonly signalTarget: (signal: NodeJS.Signals) => void;
}

/** @internal Injectable platform boundary for cross-platform conformance tests. */
export interface HarnessPlatformAdapter {
  readonly platform: NodeJS.Platform;
  readonly createProcessTreeRuntime: (
    signalTarget: (signal: NodeJS.Signals) => void,
  ) => ProcessTreeRuntime;
}

export interface SpawnedHarnessProcess {
  readonly root: ChildProcessWithoutNullStreams;
  readonly target: HarnessTargetLifecycle;
  readonly runtime: ProcessTreeRuntime;
}

export function spawnHarnessProcess(
  options: SpawnHarnessChildOptions,
): SpawnedHarnessProcess {
  return spawnHarnessProcessWithAdapter(options, {
    platform: process.platform,
    createProcessTreeRuntime: (signalTarget) =>
      createNodeProcessTreeRuntime(process.platform, signalTarget),
  });
}

export function spawnHarnessProcessWithAdapter(
  options: SpawnHarnessChildOptions,
  adapter: HarnessPlatformAdapter,
): SpawnedHarnessProcess {
  const args = [...(options.args ?? [])];
  if (adapter.platform === 'win32') {
    const target = spawnWindowsSentinel({ ...options, args });
    return {
      root: target.root,
      target,
      runtime: adapter.createProcessTreeRuntime(target.signalTarget),
    };
  }
  const root = spawn(options.command, args, {
    cwd: options.cwd,
    detached: true,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const target = createDirectTargetLifecycle(root);
  return {
    root,
    target,
    runtime: adapter.createProcessTreeRuntime(target.signalTarget),
  };
}
export function createDirectTargetLifecycle(
  child: ChildProcessWithoutNullStreams,
): HarnessTargetLifecycle {
  return {
    onTargetError: (listener) => child.once('error', listener),
    onTargetExit: (listener) => child.once('exit', listener),
    signalTarget: (signal) => {
      child.kill(signal);
    },
  };
}
