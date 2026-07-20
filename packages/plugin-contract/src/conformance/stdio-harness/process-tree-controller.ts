export type HarnessProcessState =
  | 'spawned'
  | 'running'
  | 'terminating'
  | 'exited'
  | 'reaped'
  | 'cleanup-failed';

export type TaskkillOutcome =
  | { readonly status: 'success' }
  | { readonly status: 'nonzero'; readonly code: number | null }
  | { readonly status: 'spawn-error'; readonly error: Error }
  | { readonly status: 'timeout' };

export interface ProcessTreeRuntime {
  readonly platform: NodeJS.Platform;
  readonly now: () => number;
  readonly sleep: (delayMs: number) => Promise<void>;
  readonly signalTarget: (signal: NodeJS.Signals) => void;
  readonly signalTree: (rootPid: number, signal: NodeJS.Signals) => void;
  readonly treeIsAlive: (rootPid: number) => boolean;
  readonly runTaskkill: (
    rootPid: number,
    timeoutMs: number,
  ) => Promise<TaskkillOutcome>;
}

export interface ReapProcessTreeOptions {
  readonly timeoutMs: number;
  readonly probeIntervalMs: number;
  readonly taskkillTimeoutMs: number;
  readonly targetExitGraceMs: number;
}

export class HarnessCleanupError extends Error {
  constructor(
    readonly rootPid: number | undefined,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'HarnessCleanupError';
  }
}

export class ProcessTreeController {
  private currentState: HarnessProcessState = 'spawned';
  private targetExited = false;
  private streamsClosed = false;
  private hardKillRequested = false;
  private terminationError: Error | undefined;
  private reapPromise: Promise<void> | undefined;

  constructor(
    readonly rootPid: number | undefined,
    readonly runtime: ProcessTreeRuntime,
  ) {}

  get state(): HarnessProcessState {
    return this.currentState;
  }

  markRunning(): void {
    if (this.state === 'spawned') {
      this.currentState = 'running';
    }
  }

  requestTermination(signal: NodeJS.Signals): void {
    if (this.state === 'reaped' || this.state === 'cleanup-failed') {
      return;
    }
    if (this.hardKillRequested) {
      return;
    }
    if (signal === 'SIGKILL') {
      this.hardKillRequested = true;
    }
    if (this.state === 'spawned' || this.state === 'running') {
      this.currentState = 'terminating';
    }

    try {
      if (this.rootPid === undefined || this.runtime.platform === 'win32') {
        this.runtime.signalTarget(signal);
        return;
      }
      this.runtime.signalTree(this.rootPid, signal);
    } catch (error) {
      this.terminationError =
        error instanceof Error ? error : new Error(String(error));
    }
  }

  markTargetExited(): void {
    this.targetExited = true;
    if (this.state === 'reaped' || this.state === 'cleanup-failed') {
      return;
    }
    if (this.state === 'spawned' || this.state === 'running') {
      this.currentState = 'terminating';
    }
    this.currentState = 'exited';
  }

  markStreamsClosed(): void {
    this.streamsClosed = true;
  }

  treeIsAlive(): boolean {
    return this.rootPid === undefined ? false : this.runtime.treeIsAlive(this.rootPid);
  }

  reap(options: ReapProcessTreeOptions): Promise<void> {
    validatePositiveSafeInteger(options.timeoutMs, 'cleanup timeoutMs');
    validatePositiveSafeInteger(options.probeIntervalMs, 'cleanup probeIntervalMs');
    validatePositiveSafeInteger(options.taskkillTimeoutMs, 'taskkill timeoutMs');
    validatePositiveSafeInteger(options.targetExitGraceMs, 'target-exit graceMs');
    this.reapPromise ??= this.reapOnce(options);
    return this.reapPromise;
  }

  private async reapOnce(options: ReapProcessTreeOptions): Promise<void> {
    let taskkillOutcome: TaskkillOutcome | undefined;
    let targetExitConfirmedBeforeTaskkill = true;
    if (this.runtime.platform === 'win32' && this.rootPid !== undefined) {
      const targetExitDeadline = this.runtime.now() + options.targetExitGraceMs;
      while (!this.targetExited && this.runtime.now() < targetExitDeadline) {
        await this.runtime.sleep(
          Math.min(
            options.probeIntervalMs,
            targetExitDeadline - this.runtime.now(),
          ),
        );
      }
      targetExitConfirmedBeforeTaskkill = this.targetExited;
      try {
        taskkillOutcome = await this.runtime.runTaskkill(
          this.rootPid,
          options.taskkillTimeoutMs,
        );
      } catch (error) {
        taskkillOutcome = {
          status: 'spawn-error',
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
      if (taskkillOutcome.status !== 'success') {
        this.currentState = 'cleanup-failed';
        const outcome = describeTaskkillOutcome(taskkillOutcome);
        const terminationDetail =
          this.terminationError === undefined
            ? ''
            : `; termination signal failed: ${this.terminationError.message}`;
        const cause =
          this.terminationError ??
          (taskkillOutcome.status === 'spawn-error'
            ? taskkillOutcome.error
            : undefined);
        throw new HarnessCleanupError(
          this.rootPid,
          `harness process-tree cleanup has no whole-tree evidence after taskkill ${outcome}${terminationDetail}`,
          cause === undefined ? undefined : { cause },
        );
      }
    }

    const deadline = this.runtime.now() + options.timeoutMs;
    while (true) {
      let treeAlive: boolean;
      try {
        treeAlive = this.treeIsAlive();
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        this.currentState = 'cleanup-failed';
        throw new HarnessCleanupError(
          this.rootPid,
          `harness process-tree cleanup probe failed: ${cause.message}`,
          { cause },
        );
      }
      if (!treeAlive && this.targetExited && this.streamsClosed) {
        if (!targetExitConfirmedBeforeTaskkill) {
          this.currentState = 'cleanup-failed';
          throw new HarnessCleanupError(
            this.rootPid,
            'Windows sentinel did not report target exit before taskkill reaped the wrapper root',
          );
        }
        this.currentState = 'reaped';
        return;
      }
      if (this.runtime.now() >= deadline) {
        this.currentState = 'cleanup-failed';
        const outcome = describeTaskkillOutcome(taskkillOutcome);
        const terminationDetail =
          this.terminationError === undefined
            ? ''
            : `; termination signal failed: ${this.terminationError.message}`;
        const cause =
          this.terminationError ??
          (taskkillOutcome?.status === 'spawn-error'
            ? taskkillOutcome.error
            : undefined);
        throw new HarnessCleanupError(
          this.rootPid,
          `harness process-tree cleanup failed after taskkill ${outcome}${terminationDetail}`,
          cause === undefined ? undefined : { cause },
        );
      }
      await this.runtime.sleep(
        Math.min(options.probeIntervalMs, deadline - this.runtime.now()),
      );
    }
  }
}

function validatePositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function describeTaskkillOutcome(outcome: TaskkillOutcome | undefined): string {
  if (outcome === undefined) {
    return 'not-applicable';
  }
  if (outcome.status === 'nonzero') {
    return `nonzero (code=${String(outcome.code)})`;
  }
  if (outcome.status === 'spawn-error') {
    return `spawn-error (${outcome.error.message})`;
  }
  return outcome.status;
}
