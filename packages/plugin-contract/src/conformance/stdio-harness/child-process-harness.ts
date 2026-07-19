import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import {
  NdjsonFrameDecoder,
  encodeNdjsonFrame,
  type DecodedNdjsonFrame,
  type JsonObject,
} from './ndjson-frame.js';

export interface SpawnHarnessChildOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

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
  private resolveExit!: (exit: HarnessChildExit) => void;
  private exit: HarnessChildExit | undefined;
  private fatalError: Error | undefined;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.pid = child.pid;
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });

    child.stdout.on('data', (chunk: Buffer) => {
      try {
        for (const frame of this.decoder.push(chunk)) {
          this.enqueue(frame);
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        child.kill('SIGKILL');
      }
    });
    child.stdout.on('end', () => {
      if (this.fatalError !== undefined) {
        return;
      }
      try {
        for (const frame of this.decoder.end()) {
          this.enqueue(frame);
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        child.kill('SIGKILL');
      }
    });
    child.once('error', (error) => {
      this.fail(error);
    });
    child.stderr.resume();
    child.once('close', (code, signal) => {
      const exit = { code, signal } satisfies HarnessChildExit;
      this.exit = exit;
      this.resolveExit(exit);
      if (this.fatalError === undefined) {
        this.fail(new HarnessChildExitedError(exit));
      }
    });
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
    if (this.fatalError !== undefined) {
      throw this.fatalError;
    }
    if (this.exit !== undefined) {
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
    if (this.exit === undefined) {
      this.child.kill(signal);
    }
  }

  waitForExit(): Promise<HarnessChildExit> {
    return this.exitPromise;
  }

  async stop(terminateGraceMs = 100): Promise<HarnessChildExit> {
    if (this.exit !== undefined) {
      return this.exit;
    }
    this.child.stdin.end();
    this.child.kill('SIGTERM');

    const exitedDuringGrace = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), terminateGraceMs);
      this.exitPromise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!exitedDuringGrace && this.exit === undefined) {
      this.child.kill('SIGKILL');
    }
    return this.exitPromise;
  }

  private assertRunning(): void {
    if (this.fatalError !== undefined) {
      throw this.fatalError;
    }
    if (this.exit !== undefined) {
      throw new HarnessChildExitedError(this.exit);
    }
  }

  private enqueue(frame: DecodedNdjsonFrame): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      this.frames.push(frame);
      return;
    }
    clearTimeout(waiter.timer);
    waiter.resolve(frame);
  }

  private fail(error: Error): void {
    if (this.fatalError !== undefined) {
      return;
    }
    this.fatalError = error;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

export function spawnHarnessChild(options: SpawnHarnessChildOptions): HarnessChild {
  const child = spawn(options.command, [...(options.args ?? [])], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return new HarnessChild(child);
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

  try {
    return await Promise.race([
      execute(child),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new HarnessTimeoutError(
              `harness case timed out after ${options.timeoutMs}ms`,
            ),
          );
        }, options.timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    await child.stop(options.terminateGraceMs);
  }
}
