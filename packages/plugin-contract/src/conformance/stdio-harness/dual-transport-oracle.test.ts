import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runDualTransportOracle,
  type OracleTransport,
} from './dual-transport-oracle.js';

interface Operation {
  readonly value: number;
}

interface Result {
  readonly status: 'success';
  readonly doubled: number;
}

interface Observation {
  readonly values: readonly number[];
}

class RecordingTransport implements OracleTransport<Operation, Result, Observation> {
  private readonly values: number[] = [];

  constructor(private readonly offset = 0) {}

  async setup(): Promise<void> {
    this.values.length = 0;
  }

  async observe(): Promise<Observation> {
    return { values: this.values };
  }

  async execute(operation: Operation): Promise<Result> {
    this.values.push(operation.value + this.offset);
    return { status: 'success', doubled: operation.value * 2 + this.offset };
  }
}

test('passes when in-process and wire transcripts are deeply identical', async () => {
  const report = await runDualTransportOracle(
    { id: 'same-semantics', input: { value: 4 } },
    new RecordingTransport(),
    new RecordingTransport(),
  );

  assert.equal(report.passed, true);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.inProcess.after, { values: [4] });
  assert.deepEqual(report.wire.after, { values: [4] });
});

test('reports result and side-effect drift independently', async () => {
  const report = await runDualTransportOracle(
    { id: 'wire-drift', input: { value: 4 } },
    new RecordingTransport(),
    new RecordingTransport(1),
  );

  assert.equal(report.passed, false);
  assert.match(report.failures.join('\n'), /result mismatch/);
  assert.match(report.failures.join('\n'), /after observation mismatch/);
});

test('snapshots live observations and clones input per transport', async () => {
  const input = { value: 4 };
  const values: number[] = [];
  const mutating: OracleTransport<Operation, Result, Observation> = {
    async setup(): Promise<void> {
      values.length = 0;
    },
    async observe(): Promise<Observation> {
      return { values };
    },
    async execute(operation): Promise<Result> {
      (operation as { value: number }).value = 99;
      values.push(4);
      return { status: 'success', doubled: 8 };
    },
  };

  const report = await runDualTransportOracle(
    { id: 'clone-boundaries', input },
    mutating,
    new RecordingTransport(),
  );

  assert.equal(report.passed, true);
  assert.deepEqual(report.inProcess.before, { values: [] });
  assert.deepEqual(input, { value: 4 });
});
