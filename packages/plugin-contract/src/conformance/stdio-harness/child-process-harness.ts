import { type ChildProcessWithoutNullStreams } from 'node:child_process';

import {
  createDirectTargetLifecycle,
  spawnHarnessProcess,
  spawnHarnessProcessWithAdapter,
  type HarnessPlatformAdapter,
  type HarnessTargetLifecycle,
  type SpawnHarnessChildOptions,
} from './harness-process-spawn.js';
import {
  NdjsonFrameDecoder,
  encodeNdjsonFrame,
  type DecodedNdjsonFrame,
  type JsonObject,
} from './ndjson-frame.js';
import { createNodeProcessTreeRuntime } from './node-process-tree-runtime.js';
import {
  HarnessCleanupError,
  ProcessTreeController,
  type ProcessTreeRuntime,
} from './process-tree-controller.js';

export { HarnessCleanupError } from './process-tree-controller.js';
export type {
  HarnessPlatformAdapter,
  SpawnHarnessChildOptions,
} from './harness-process-spawn.js';

export const MAX_HARNESS_QUEUED_FRAMES = 16;

const HARNESS_CLEANUP_TIMEOUT_MS = 1_000;
const HARNESS_CLEANUP_PROBE_INTERVAL_MS = 5;
const TASKKILL_TIMEOUT_MS = 500;
const TARGET_EXIT_GRACE_MS = 500;

export interface HarnessReceiveOptions {
  readonly timeoutMs: number;
}

export interface HarnessChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface RunHarnessCaseOptions extends SpawnHarnessChildOptions {
  readonly timeoutMs: number;
  readonly terminateGraceMs?: number;
}

export class HarnessTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessTimeoutError';
  }
}

export class HarnessChildExitedError extends Error {
  constructor(readonly exit: HarnessChildExit) {
    super(
      `harness child exited before another frame was available (code=${String(exit.code)}, signal=${String(exit.signal)})`,
    );
    this.name = 'HarnessChildExitedError';
  }
}

export class HarnessFrameBacklogError extends Error {
  constructor(readonly maxQueuedFrames = MAX_HARNESS_QUEUED_FRAMES) {
    super(`decoded child frame backlog exceeded ${maxQueuedFrames} queued frames`);
    this.name = 'HarnessFrameBacklogError';
  }
}

interface FrameWaiter {
  readonly resolve: (frame: DecodedNdjsonFrame) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class HarnessChild {
  readonly pid: number | undefined;

  private readonly decoder = new NdjsonFrameDecoder();
  private readonly frames: DecodedNdjsonFrame[] = [];
  private readonly waiters: FrameWaiter[] = [];
  private readonly exitPromise: Promise<HarnessChildExit>;
  private readonly processTree: ProcessTreeController;
  private resolveExit!: (exit: HarnessChildExit) => void;
  private exit: HarnessChildExit | undefined;
  private streamsClosed = false;
  private stopPromise: Promise<HarnessChildExit> | undefined;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    target: HarnessTargetLifecycle = createDirectTargetLifecycle(child),
    runtime: ProcessTreeRuntime = createNodeProcessTreeRuntime(
      process.platform,
      target.signalTarget,
    ),
  ) {
    this.pid = child.pid;
    this.processTree = new ProcessTreeController(this.pid, runtime);
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });

    child.stdout.on('data', (chunk: Buffer) => {
      try {
        for (const frame of this.decoder.push(chunk)) {
          this.enqueue(frame);
        }
      } catch (error) {
        this.failAndKill(error);
      }
    });
    child.stdout.on('end', () => {
      if (harnessFatalErrors.has(this)) {
        return;
      }
      try {
        for (const frame of this.decoder.end()) {
          this.enqueue(frame);
        }
      } catch (error) {
        this.failAndKill(error);
      }
    });
    child.stdin.on('error', (error) => this.failAndKill(error));
    child.stdout.on('error', (error) => this.failAndKill(error));
    child.stderr.on('error', (error) => this.failAndKill(error));
    target.onTargetError((error) => this.failAndKill(error));
    child.stderr.resume();
    const recordExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): HarnessChildExit => {
      if (this.exit === undefined) {
        this.exit = { code, signal };
        this.processTree.markTargetExited();
        this.resolveExit(this.exit);
      }
      return this.exit;
    };
    target.onTargetExit(recordExit);
    child.once('close', (code, signal) => {
      const exit = recordExit(code, signal);
      this.streamsClosed = true;
      this.processTree.markStreamsClosed();
      if (!harnessFatalErrors.has(this)) {
        this.rejectWaiters(new HarnessChildExitedError(exit));
      }
    });
    this.processTree.markRunning();
  }

  async send(frame: JsonObject): Promise<void> {
    this.assertRunning();
    const encoded = encodeNdjsonFrame(frame);
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(encoded, (error) => {
        if (error === null || error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  }

  async receive(options: HarnessReceiveOptions): Promise<DecodedNdjsonFrame> {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new RangeError('receive timeoutMs must be a positive safe integer');
    }
    const frame = this.frames.shift();
    if (frame !== undefined) {
      return frame;
    }
    const fatalError = harnessFatalErrors.get(this);
    if (fatalError !== undefined) {
      throw fatalError;
    }
    if (this.streamsClosed && this.exit !== undefined) {
      throw new HarnessChildExitedError(this.exit);
    }

    return new Promise<DecodedNdjsonFrame>((resolve, reject) => {
      const waiter: FrameWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) {
            this.waiters.splice(index, 1);
          }
          reject(
            new HarnessTimeoutError(
              `timed out after ${options.timeoutMs}ms waiting for child frame`,
            ),
          );
        }, options.timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  kill(signal: NodeJS.Signals = 'SIGKILL'): void {
    this.processTree.requestTermination(signal);
    if (signal === 'SIGKILL') {
      void this.startReap();
    }
  }

  waitForExit(): Promise<HarnessChildExit> {
    return this.exitPromise;
  }

  async stop(terminateGraceMs = 100): Promise<HarnessChildExit> {
    if (!Number.isSafeInteger(terminateGraceMs) || terminateGraceMs < 0) {
      throw new RangeError('terminateGraceMs must be a non-negative safe integer');
    }
    this.stopPromise ??= this.stopOnce(terminateGraceMs);
    return await this.stopPromise;
  }

  private async stopOnce(terminateGraceMs: number): Promise<HarnessChildExit> {
    this.child.stdin.end();
    this.processTree.requestTermination('SIGTERM');

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, terminateGraceMs);
      this.exitPromise.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.processTree.requestTermination('SIGKILL');
    await this.startReap();
    return await this.exitPromise;
  }

  private assertRunning(): void {
    const fatalError = harnessFatalErrors.get(this);
    if (fatalError !== undefined) {
      throw fatalError;
    }
    if (this.exit !== undefined) {
      throw new HarnessChildExitedError(this.exit);
    }
  }

  private enqueue(frame: DecodedNdjsonFrame): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      if (this.frames.length >= MAX_HARNESS_QUEUED_FRAMES) {
        throw new HarnessFrameBacklogError();
      }
      this.frames.push(frame);
      return;
    }
    clearTimeout(waiter.timer);
    waiter.resolve(frame);
  }

  private fail(error: Error, discardQueuedFrames = false): void {
    if (harnessFatalErrors.has(this)) {
      if (discardQueuedFrames) {
        this.frames.splice(0);
      }
      return;
    }
    harnessFatalErrors.set(this, error);
    if (discardQueuedFrames) {
      this.frames.splice(0);
    }
    this.rejectWaiters(error);
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private failAndKill(error: unknown): void {
    this.fail(error instanceof Error ? error : new Error(String(error)), true);
    this.kill('SIGKILL');
  }

  private startReap(): Promise<void> {
    const cleanup = this.processTree.reap({
      timeoutMs: HARNESS_CLEANUP_TIMEOUT_MS,
      probeIntervalMs: HARNESS_CLEANUP_PROBE_INTERVAL_MS,
      taskkillTimeoutMs: TASKKILL_TIMEOUT_MS,
      targetExitGraceMs: TARGET_EXIT_GRACE_MS,
    });
    void cleanup.catch((error: unknown) => {
      this.fail(error instanceof Error ? error : new Error(String(error)), true);
    });
    return cleanup;
  }
}

const harnessFatalErrors = new WeakMap<HarnessChild, Error>();

export function spawnHarnessChild(options: SpawnHarnessChildOptions): HarnessChild {
  const spawned = spawnHarnessProcess(options);
  return new HarnessChild(spawned.root, spawned.target, spawned.runtime);
}

export function spawnHarnessChildWithAdapter(
  options: SpawnHarnessChildOptions,
  adapter: HarnessPlatformAdapter,
): HarnessChild {
  const spawned = spawnHarnessProcessWithAdapter(options, adapter);
  return new HarnessChild(spawned.root, spawned.target, spawned.runtime);
}

export async function runHarnessCase<T>(
  options: RunHarnessCaseOptions,
  execute: (child: HarnessChild) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new RangeError('case timeoutMs must be a positive safe integer');
  }
  const child = spawnHarnessChild(options);
  let timer: NodeJS.Timeout | undefined;
  let completed = false;
  let result!: T;
  let executionError: unknown;

  try {
    result = await Promise.race([
      execute(child),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(
            new HarnessTimeoutError(
              `harness case timed out after ${options.timeoutMs}ms`,
            ),
          );
        }, options.timeoutMs);
      }),
    ]);
    completed = true;
  } catch (error) {
    executionError = error;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    await child.stop(options.terminateGraceMs);
  }

  const fatalError = harnessFatalErrors.get(child);
  if (fatalError !== undefined) {
    throw fatalError;
  }
  if (!completed) {
    throw executionError;
  }
  return result;
}
