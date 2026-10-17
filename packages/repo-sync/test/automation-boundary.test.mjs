import assert from 'node:assert/strict';
import test from 'node:test';
import { synchronize, validateAutomation } from '../src/automation.mjs';
import { SyncService } from '../src/sync-service.mjs';
import { runExecution } from '../src/execution.mjs';

const runId = 'a'.repeat(32);
class MemoryStore {
  constructor(state) {
    this.state = structuredClone(state);
    this.pending = Promise.resolve();
  }
  async read() {
    return structuredClone(this.state);
  }
  async save(state) {
    this.state = structuredClone(state);
  }
  async locked(action) {
    const prior = this.pending;
    let release;
    this.pending = new Promise((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await action();
    } finally {
      release();
    }
  }
}
class Harness {
  constructor(state) {
    this.config = {
      mode: 'continuous',
      pullRequests: {},
      issues: {},
      commitClosureVerified: true,
      bindingId: 'binding',
    };
    this.store = new MemoryStore(
      state ?? {
        accepted: { upstream: 'base', internal: 'internal-base' },
        queue: [{ target: 'one' }, { target: 'two' }],
        deliveries: [],
        activeId: null,
        events: [],
      },
    );
    this.merged = new Set();
    this.created = [];
    this.closed = [];
    this.metadataFails = false;
    this.git = { remoteBranch: async () => 'changed-head' };
  }
  read() {
    return this.store.read();
  }
  active(state) {
    return state.deliveries.find((item) => item.id === state.activeId && item.status !== 'COMPLETE');
  }
  async status() {
    const state = await this.read();
    return { ...state, active: this.active(state) };
  }
  async change(action) {
    return this.store.locked(async () => {
      const state = await this.read();
      try {
        await action(state);
      } finally {
        await this.store.save(state);
      }
      return state;
    });
  }
  async start(target) {
    if (this.beforeAdmission) await this.beforeAdmission();
    return this.change((state) => {
      assert.equal(target, state.queue[0].target);
      const delivery = {
        id: target,
        target,
        status: 'ISSUES_REQUIRED',
        issues: [{ sourceId: `issue-${target}` }],
        base: { ...state.accepted },
      };
      state.deliveries.push(delivery);
      state.activeId = target;
      this.created.push(target);
    });
  }
  prepare() {
    return this.change((state) => {
      const d = this.active(state);
      d.status = 'WAITING_APPROVAL';
      d.prUrl = `https://platform.example/pr/${d.id}`;
    });
  }
  recover() {
    return this.change((state) => {
      const d = this.active(state);
      if (!this.merged.has(d.id)) return;
      d.acceptedInternal = `internal-${d.id}`;
      state.accepted = { upstream: d.target, internal: d.acceptedInternal };
      d.status = 'CODE_ACCEPTED_PENDING_METADATA';
      if (this.metadataFails) throw Object.assign(new Error('metadata unavailable'), { code: 'ISSUE_NETWORK' });
      this.closed.push(d.id);
      d.status = 'COMPLETE';
      state.queue.shift();
      state.activeId = null;
    });
  }
}
const begin = (receiver, continuation = 'automatic') =>
  synchronize(receiver, { action: 'synchronize', requestId: runId, continuation });
const pause = (receiver) => synchronize(receiver, { action: 'pause-sync', runId });
const resume = (receiver, observeOnly = false) => synchronize(receiver, { action: 'resume-sync', runId, observeOnly });

test('requesting pause while waiting keeps current PR observation alive and pauses after metadata, before next admission', async () => {
  const receiver = new Harness();
  await begin(receiver);
  await pause(receiver);
  let state = await receiver.status();
  assert.equal(state.automation.status, 'WAITING_REVIEW');
  assert.equal(state.automation.pauseRequested.afterDeliveryId, 'one');
  receiver.merged.add('one');
  await resume(receiver, true);
  state = await receiver.status();
  assert.equal(state.automation.status, 'PAUSED');
  assert.deepEqual(receiver.closed, ['one']);
  assert.deepEqual(receiver.created, ['one']);
  assert.equal(state.accepted.upstream, 'one');
  assert.equal(state.queue[0].target, 'two');
});

test('after-each survives restart, releases one delivery explicitly and stops again at the next boundary', async () => {
  let receiver = new Harness();
  await begin(receiver, 'after-each');
  const restarted = new Harness(await receiver.read());
  restarted.created = [...receiver.created];
  receiver = restarted;
  receiver.merged.add('one');
  await resume(receiver, true);
  assert.equal((await receiver.status()).automation.status, 'PAUSED');
  assert.equal((await receiver.status()).automation.pauseRequested?.afterDeliveryId, 'one');
  await resume(receiver, true);
  assert.deepEqual(receiver.created, ['one']);
  await resume(receiver);
  assert.deepEqual(receiver.created, ['one', 'two']);
  assert.equal((await receiver.status()).automation.continuation, 'after-each');
  receiver.merged.add('two');
  await resume(receiver, true);
  assert.equal((await receiver.status()).automation.status, 'COMPLETE');
});

test('metadata failure retains the boundary request and explicit recovery cannot accidentally start next PR', async () => {
  const receiver = new Harness();
  await begin(receiver);
  await pause(receiver);
  receiver.merged.add('one');
  receiver.metadataFails = true;
  await assert.rejects(resume(receiver, true), { code: 'ISSUE_NETWORK' });
  assert.equal((await receiver.status()).automation.pauseRequested.afterDeliveryId, 'one');
  receiver.metadataFails = false;
  await resume(receiver);
  assert.equal((await receiver.status()).automation.status, 'PAUSED');
  assert.deepEqual(receiver.created, ['one']);
  assert.deepEqual(receiver.closed, ['one']);
});

test('an observer queued before pause cannot release an already paused boundary', async () => {
  const receiver = new Harness();
  await begin(receiver, 'after-each');
  receiver.merged.add('one');
  await resume(receiver, true);
  const before = await receiver.read();
  await resume(receiver, true);
  assert.deepEqual(await receiver.read(), before);
  assert.deepEqual(receiver.created, ['one']);
});

test('pause is rechecked under the next-delivery admission lock', async () => {
  const receiver = new Harness();
  await begin(receiver);
  receiver.merged.add('one');
  receiver.beforeAdmission = async () => {
    receiver.beforeAdmission = null;
    await pause(receiver);
  };
  await resume(receiver, true);
  assert.equal((await receiver.status()).automation.status, 'PAUSED');
  assert.deepEqual(receiver.created, ['one']);
});

test('switching to automatic at a paused boundary waits for explicit resume', async () => {
  const receiver = new Harness();
  await begin(receiver, 'after-each');
  receiver.merged.add('one');
  await resume(receiver, true);
  await synchronize(receiver, { action: 'configure-continuation', runId, continuation: 'automatic' });
  assert.equal((await receiver.status()).automation.status, 'PAUSED');
  assert.equal((await receiver.status()).automation.pauseRequested?.afterDeliveryId, 'one');
  await resume(receiver, true);
  assert.deepEqual(receiver.created, ['one']);
  await resume(receiver);
  assert.deepEqual(receiver.created, ['one', 'two']);
});

test('legacy PAUSED records still require explicit resume and malformed new policy is rejected', async () => {
  const receiver = new Harness();
  await begin(receiver);
  await receiver.change((state) => {
    state.automation.status = 'PAUSED';
    delete state.automation.continuation;
    delete state.automation.pauseRequested;
  });
  await resume(receiver, true);
  assert.equal((await receiver.status()).automation.status, 'PAUSED');
  await resume(receiver);
  assert.equal((await receiver.status()).automation.status, 'WAITING_REVIEW');
  const run = (await receiver.status()).automation;
  assert.throws(() => validateAutomation({ ...run, continuation: 'unknown' }), { code: 'AUTOMATION_INVALID' });
});

test('background observation explicitly declares observation-only intent', async () => {
  let input;
  const receiver = new Harness();
  await begin(receiver);
  await pause(receiver);
  receiver.merged.add('one');
  const service = new SyncService(
    async () => ({
      receiver,
      tasks: {
        busy: () => false,
        latest: async () => null,
        start: async (value) => {
          input = value;
        },
      },
      options: {},
    }),
    3600000,
  );
  try {
    await service.observe();
    assert.equal(input?.observeOnly, true);
  } finally {
    await service.close();
  }
});

test('new continuation records validate shape while old runs without the optional policy remain readable', () => {
  const run = { id: runId, status: 'PAUSED', startedAt: '2026-10-15T00:00:00Z', selection: { kind: 'queue' } };
  assert.doesNotThrow(() => validateAutomation(run));
  const request = { afterDeliveryId: 'd'.repeat(24), requestedAt: run.startedAt };
  assert.doesNotThrow(() => validateAutomation({ ...run, continuation: 'after-each', pauseRequested: request }));
  for (const pauseRequested of [
    null,
    [],
    {},
    { ...request, afterDeliveryId: 'bad-id' },
    { ...request, requestedAt: 'invalid' },
    { ...request, unknown: true },
  ])
    assert.throws(() => validateAutomation({ ...run, pauseRequested }), { code: 'AUTOMATION_INVALID' });
});

test('the first delivery remains in review without repeating preparation when it has not merged', async () => {
  const receiver = new Harness();
  let preparations = 0;
  const original = receiver.prepare;
  receiver.prepare = function () {
    preparations += 1;
    return original.call(this);
  };
  await begin(receiver, 'after-each');
  await resume(receiver, true);
  assert.equal(preparations, 1);
  assert.equal((await receiver.status()).automation.status, 'WAITING_REVIEW');
  assert.deepEqual(receiver.created, ['one']);
});

test('a concurrent preference change at the boundary cannot erase a durable pause or mark queued work complete', async () => {
  const receiver = new Harness();
  await begin(receiver, 'after-each');
  receiver.merged.add('one');
  const status = receiver.status;
  let changed = false;
  receiver.status = async function () {
    const state = await status.call(this);
    if (!changed && !state.active && state.automation.pauseRequested) {
      changed = true;
      await pause(receiver);
      await synchronize(receiver, { action: 'configure-continuation', runId, continuation: 'automatic' });
    }
    return state;
  };
  await resume(receiver, true);
  const state = await receiver.status();
  assert.equal(changed, true);
  assert.equal(state.automation.status, 'PAUSED');
  assert.equal(state.queue.length, 1);
  assert.deepEqual(receiver.created, ['one']);
});

test('selecting per-delivery pause between deliveries prevents the next admission immediately', async () => {
  const receiver = new Harness();
  await begin(receiver);
  receiver.merged.add('one');
  await receiver.recover();
  await synchronize(receiver, { action: 'configure-continuation', runId, continuation: 'after-each' });
  assert.equal((await receiver.status()).automation.status, 'PAUSED');
  await resume(receiver, true);
  assert.deepEqual(receiver.created, ['one']);
});

test('the next delivery start parent phase cannot retain the previously accepted delivery association', async () => {
  const receiver = new Harness();
  await begin(receiver);
  receiver.merged.add('one');
  const starts = [],
    associations = [];
  const context = {
    deliveryId: 'one',
    signal: new AbortController().signal,
    associate: (id) => associations.push(id),
    report: (event) => {
      if (event.kind === 'start') starts.push({ key: event.id, deliveryId: context.deliveryId });
    },
  };
  await runExecution(context, () => resume(receiver, true));
  assert.equal(starts.find((event) => event.key === 'delivery-verify').deliveryId, 'one');
  assert.equal(starts.find((event) => event.key === 'delivery-start').deliveryId, null);
  assert.ok(associations.includes(null));
  assert.deepEqual(receiver.created, ['one', 'two']);
});
