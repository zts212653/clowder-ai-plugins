import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HarnessCleanupError,
  ProcessTreeController,
  type ProcessTreeRuntime,
  type TaskkillOutcome,
} from './process-tree-controller.js';

interface FakeRuntimeOptions {
  readonly platform?: NodeJS.Platform;
  readonly outcome?: TaskkillOutcome;
  readonly alive?: readonly boolean[];
}

interface FakeRuntime {
  readonly runtime: ProcessTreeRuntime;
  readonly taskkillPids: number[];
  readonly targetSignals: NodeJS.Signals[];
  readonly treeSignals: NodeJS.Signals[];
  readonly probeCount: () => number;
}

function createFakeRuntime(options: FakeRuntimeOptions = {}): FakeRuntime {
  let now = 0;
  let probeIndex = 0;
  const alive = options.alive ?? [true];
  const taskkillPids: number[] = [];
  const targetSignals: NodeJS.Signals[] = [];
  const treeSignals: NodeJS.Signals[] = [];

  return {
    taskkillPids,
    targetSignals,
    treeSignals,
    probeCount: () => probeIndex,
    runtime: {
      platform: options.platform ?? 'win32',
      now: () => now,
      sleep: async (delayMs) => {
        now += delayMs;
      },
      signalTarget: (signal) => {
        targetSignals.push(signal);
      },
      signalTree: (_rootPid, signal) => {
        treeSignals.push(signal);
      },
      treeIsAlive: () => {
        const value = alive[Math.min(probeIndex, alive.length - 1)] ?? false;
        probeIndex += 1;
        return value;
      },
      runTaskkill: async (rootPid) => {
        taskkillPids.push(rootPid);
        return options.outcome ?? { status: 'success' };
      },
    },
  };
}

function exitedController(fake: FakeRuntime): ProcessTreeController {
  const controller = new ProcessTreeController(7_331, fake.runtime);
  controller.markRunning();
  controller.markTargetExited();
  controller.markStreamsClosed();
  return controller;
}

const reapOptions = {
  timeoutMs: 20,
  probeIntervalMs: 5,
  taskkillTimeoutMs: 10,
  targetExitGraceMs: 10,
} as const;

test('uses the stable Windows sentinel root after the target exits', async () => {
  const fake = createFakeRuntime({ alive: [false] });
  const controller = exitedController(fake);

  await controller.reap(reapOptions);

  assert.deepEqual(fake.taskkillPids, [7_331]);
  assert.equal(controller.state, 'reaped');
});

test('lets the sentinel report target exit before taskkill reaps the wrapper root', async () => {
  let now = 0;
  let controller: ProcessTreeController;
  const events: string[] = [];
  const runtime: ProcessTreeRuntime = {
    platform: 'win32',
    now: () => now,
    sleep: async (delayMs) => {
      events.push('wait-target-exit');
      now += delayMs;
      controller.markTargetExited();
    },
    signalTarget: () => events.push('signal-target'),
    signalTree: () => assert.fail('Windows cleanup must not signal a POSIX group'),
    treeIsAlive: () => false,
    runTaskkill: async () => {
      events.push('taskkill-root');
      controller.markStreamsClosed();
      return { status: 'success' };
    },
  };
  controller = new ProcessTreeController(7_331, runtime);
  controller.markRunning();
  controller.requestTermination('SIGKILL');

  await controller.reap(reapOptions);

  assert.deepEqual(events, [
    'signal-target',
    'wait-target-exit',
    'taskkill-root',
  ]);
  assert.equal(controller.state, 'reaped');
});

test('fails closed when wrapper exit is the first claimed target-exit signal', async () => {
  let now = 0;
  let controller: ProcessTreeController;
  const runtime: ProcessTreeRuntime = {
    platform: 'win32',
    now: () => now,
    sleep: async (delayMs) => {
      now += delayMs;
    },
    signalTarget: () => {},
    signalTree: () => assert.fail('Windows cleanup must not signal a POSIX group'),
    treeIsAlive: () => false,
    runTaskkill: async () => {
      controller.markTargetExited();
      controller.markStreamsClosed();
      return { status: 'success' };
    },
  };
  controller = new ProcessTreeController(7_331, runtime);
  controller.markRunning();
  controller.requestTermination('SIGKILL');

  await assert.rejects(
    controller.reap(reapOptions),
    (error: unknown) =>
      error instanceof HarnessCleanupError &&
      error.message.includes('before taskkill'),
  );
  assert.equal(controller.state, 'cleanup-failed');
});

for (const outcome of [
  { status: 'success' },
  { status: 'nonzero', code: 128 },
  { status: 'spawn-error', error: new Error('taskkill missing') },
  { status: 'timeout' },
] satisfies readonly TaskkillOutcome[]) {
  test(`fails closed when taskkill ${outcome.status} leaves the tree alive`, async () => {
    const fake = createFakeRuntime({ outcome, alive: [true] });
    const controller = exitedController(fake);

    await assert.rejects(
      controller.reap(reapOptions),
      (error: unknown) =>
        error instanceof HarnessCleanupError &&
        error.rootPid === 7_331 &&
        error.message.includes(outcome.status),
    );
    assert.equal(controller.state, 'cleanup-failed');
  });
}

test('kill utility failure still reaps when bounded probes prove the tree is gone', async () => {
  const fake = createFakeRuntime({
    outcome: { status: 'nonzero', code: 128 },
    alive: [false],
  });
  const controller = exitedController(fake);

  await controller.reap(reapOptions);

  assert.equal(controller.state, 'reaped');
});

test('polls until the whole tree is gone instead of trusting taskkill exit', async () => {
  const fake = createFakeRuntime({ alive: [true, true, false] });
  const controller = exitedController(fake);

  await controller.reap(reapOptions);

  assert.equal(fake.probeCount(), 3);
  assert.equal(controller.state, 'reaped');
});

test('requires target exit and stream close before declaring the tree reaped', async () => {
  const fake = createFakeRuntime({ alive: [false] });
  const controller = new ProcessTreeController(7_331, fake.runtime);
  controller.markRunning();
  controller.markTargetExited();

  await assert.rejects(
    controller.reap(reapOptions),
    (error: unknown) => error instanceof HarnessCleanupError,
  );
  assert.equal(controller.state, 'cleanup-failed');
});

test('converts an existence-probe failure into the public cleanup error', async () => {
  const fake = createFakeRuntime({ alive: [false] });
  const controller = new ProcessTreeController(7_331, {
    ...fake.runtime,
    treeIsAlive: () => {
      throw new Error('probe denied');
    },
  });
  controller.markRunning();
  controller.markTargetExited();
  controller.markStreamsClosed();

  await assert.rejects(
    controller.reap(reapOptions),
    (error: unknown) =>
      error instanceof HarnessCleanupError && error.message.includes('probe denied'),
  );
  assert.equal(controller.state, 'cleanup-failed');
});

test('never downgrades a hard POSIX tree kill to a later soft signal', () => {
  const fake = createFakeRuntime({ platform: 'linux' });
  const controller = new ProcessTreeController(7_331, fake.runtime);
  controller.markRunning();

  controller.requestTermination('SIGKILL');
  controller.requestTermination('SIGTERM');

  assert.deepEqual(fake.treeSignals, ['SIGKILL']);
  assert.equal(controller.state, 'terminating');
});

test('defers a POSIX signal failure to the cleanup terminal state', async () => {
  const fake = createFakeRuntime({ platform: 'linux', alive: [true] });
  const controller = new ProcessTreeController(7_331, {
    ...fake.runtime,
    signalTree: () => {
      throw new Error('signal denied');
    },
  });
  controller.markRunning();

  assert.doesNotThrow(() => controller.requestTermination('SIGKILL'));
  controller.markTargetExited();
  controller.markStreamsClosed();
  await assert.rejects(
    controller.reap(reapOptions),
    (error: unknown) =>
      error instanceof HarnessCleanupError && error.message.includes('signal denied'),
  );
  assert.equal(controller.state, 'cleanup-failed');
});
