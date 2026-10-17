import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { before } from 'node:test';
import { Receiver } from '../src/engine.mjs';
import { execution, phase } from '../src/execution.mjs';
import { recordDetail } from '../src/records.mjs';
import { readTask } from '../src/task-store.mjs';
import { Tasks } from '../src/tasks.mjs';
import { attempts } from '../web/attempts.mjs';

const previousId = '1'.repeat(24),
  nextId = '2'.repeat(24),
  taskId = 'a'.repeat(32);
let observed;
before(async () => {
  observed = await admissionTrace();
});

test('associating a new delivery backfills only its live admission subtree, including already completed downloads', () => {
  const { during, rootId, descendantIds } = observed;
  assert.equal(during.status, 'RUNNING');
  for (const id of [rootId, ...descendantIds]) {
    const step = during.steps.find((item) => item.id === id);
    assert.equal(step.deliveryId, nextId, `${step.key} must acquire the delivery being registered`);
  }
  assert.equal(during.steps.find((item) => item.key === 'merge-verify').deliveryId, previousId);
  for (const key of ['round-scan', 'round-command', 'abandoned-admission'])
    assert.equal(during.steps.find((item) => item.key === key).deliveryId, undefined, `${key} must stay unscoped`);
  assert.equal(during.steps.find((item) => item.id === observed.completedRootId).deliveryId, undefined);
});

test('the admission association persists on disk and a later association cannot relabel a completed subtree', () => {
  assert.equal(observed.reloaded.status, 'SUCCEEDED');
  assert.deepEqual(new Set(observed.reloaded.deliveryIds), new Set([previousId, nextId]));
  for (const id of [observed.rootId, ...observed.descendantIds])
    assert.equal(observed.reloaded.steps.find((item) => item.id === id).deliveryId, nextId);
  assert.equal(observed.reloaded.steps.find((item) => item.key === 'round-final').deliveryId, undefined);
});

test('historical task and user-step projections keep the next admission out of the preceding delivery', () => {
  const { previous, next, rootId, descendantIds } = observed;
  for (const id of [rootId, ...descendantIds]) {
    assert.ok(!previous.tasks[0].steps.some((step) => step.id === id), 'old history must exclude the next admission');
    assert.ok(
      next.tasks[0].steps.some((step) => step.id === id),
      'new history must retain its own admission',
    );
  }
  assert.ok(previous.tasks[0].steps.some((step) => step.key === 'merge-verify'));
  assert.ok(!next.tasks[0].steps.some((step) => step.key === 'merge-verify'));
  const oldHtml = attempts(1, previous, null, true),
    newHtml = attempts(1, next, null, true);
  assert.ok(!oldHtml.includes(`data-attempt="${taskId}:${rootId}"`));
  assert.ok(newHtml.includes(`data-attempt="${taskId}:${rootId}"`));
});

async function admissionTrace() {
  const folder = await mkdtemp(join(tmpdir(), 'repo-sync-admission-owner-'));
  const receiver = new Receiver({
    sourceUrl: 'https://github.com/example/core.git',
    internalUrl: 'git@codehub.example:team/core.git',
    sourceBranch: 'main',
    targetBranch: 'main',
    mode: 'version',
    internalPaths: [],
    mergePaths: [],
    stateDir: folder,
    checks: [{ command: 'git', args: ['fsck', '--no-reflogs'] }],
  });
  let during, rootId, completedRootId, descendantIds;
  const tasks = new Tasks(
    () => receiver,
    async () => {
      const context = execution();
      await phase('round-scan', '真正的轮次扫描', () => phase('round-command', '轮次命令证据', async () => null));
      context.associate(previousId);
      await phase('delivery-verify', '前笔合入核验', () => phase('merge-verify', '核验前笔实际合入', async () => null));
      context.associate(null);
      await phase('delivery-start', '未完成登记的早期预检', () =>
        phase('abandoned-admission', '早期预检证据', async () => null),
      );
      completedRootId = tasks.value.steps.findLast((step) => step.key === 'delivery-start').id;
      await phase('delivery-start', '登记下一笔交付', async () => {
        rootId = tasks.value.steps.findLast((step) => step.key === 'delivery-start').id;
        // source-fetch fills an admission-plan slot before the wrapper in the array.
        await phase('source-fetch', '下一笔入场下载', () =>
          phase('admission-object', '下载后的对象证据', async () => null),
        );
        await phase('admission-register', '登记下一笔身份', async () => {
          context.associate(nextId);
          await tasks.writes;
          during = await readTask(receiver.config, taskId);
          descendantIds = during.steps
            .filter((step) => step.parentId === rootId || step.key === 'admission-object')
            .map((step) => step.id);
        });
      });
      context.associate(previousId); // No live admission root: never rewrite the completed subtree.
      context.associate(null);
      await phase('round-final', '真正的轮次记账', async () => null);
    },
  );
  try {
    await tasks.start({ action: 'resume-sync', requestId: taskId, expectedBinding: receiver.config.bindingId });
    await tasks.job;
    const restarted = new Tasks(
      () => receiver,
      () => assert.fail('history reads cannot execute'),
    );
    const reloaded = await restarted.latest(taskId);
    const pair = { upstream: 'b'.repeat(40), internal: 'c'.repeat(40) };
    const deliveries = [previousId, nextId].map((id, index) => ({
      id,
      mode: 'version',
      source: { id: `tag-${index}`, tag: `v${index}`, title: `版本 ${index}` },
      target: 'd'.repeat(40),
      base: pair,
      branch: `sync/${id}`,
      status: 'COMPLETE',
      candidate: 'e'.repeat(40),
      acceptedInternal: 'f'.repeat(40),
      commits: ['d'.repeat(40)],
      issues: [],
      issueResults: {},
      taskIds: [taskId],
    }));
    await receiver.store.save({
      schema: 1,
      bindingId: receiver.config.bindingId,
      mode: 'version',
      initial: pair,
      accepted: pair,
      latest: pair.upstream,
      queue: [],
      events: [],
      issues: {},
      activeId: null,
      deliveries,
    });
    const previous = await recordDetail(receiver, previousId, new URLSearchParams(), restarted);
    const next = await recordDetail(receiver, nextId, new URLSearchParams(), restarted);
    return { during, rootId, completedRootId, descendantIds, reloaded, previous, next };
  } finally {
    await tasks.close();
  }
}
