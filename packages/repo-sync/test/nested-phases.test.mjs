import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { execution, phase, runExecution } from '../src/execution.mjs';
import { Tasks } from '../src/tasks.mjs';

for (const failed of [false, true]) {
  test(`nested execution stages all reach their ${failed ? 'failed' : 'done'} state`, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'repo-sync-nested-phases-'));
    const receiver = { config: { stateDir, bindingId: 'nested-binding' } };
    const tasks = new Tasks(
      async () => receiver,
      async () =>
        phase('outer', '核验原 PR', async () => {
          await phase('inner', '核对候选 ref', async () => {
            if (failed) throw Object.assign(new Error('safe failure'), { code: 'CHECK_FAILED', safeToDisplay: true });
          });
        }),
    );
    await tasks.start({ action: 'heads', requestId: 'a'.repeat(32), expectedBinding: 'nested-binding' });
    await tasks.job;
    const stages = (await tasks.latest()).steps.filter((step) => ['核验原 PR', '核对候选 ref'].includes(step.label));
    assert.equal(stages.length, 2);
    assert.equal(
      stages.every((step) => step.status === (failed ? 'FAILED' : 'DONE')),
      true,
    );
  });
}
test('an inner readable phase cannot enable cancellation inside protected PR confirmation', async () => {
  const context = { allowCancel: true, signal: new AbortController().signal, report: () => {} };
  await runExecution(context, () =>
    phase(
      'publish',
      '候选发布核对',
      () =>
        phase('probe', '检查连接', async () => {
          assert.equal(execution().cancellable, false);
        }),
      false,
    ),
  );
});
