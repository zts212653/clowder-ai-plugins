import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { traceActualReception } from './workflow-phase-browser-fixture.mjs';

let observed;
before(
  async () => {
    observed = await traceActualReception();
  },
  { timeout: 180000 },
);

test('actual initial preparation keeps its Git checks in stage 2', () => {
  const checks = observed.fetches.filter((item) => item.expectedStage === 2 && item.action === 'synchronize');
  assert.ok(checks.length, 'fixture must execute genuine preparation downloads');
  for (const check of checks)
    assert.ok(
      check.steps.every((step) => step.stage === 2),
      `preparation must not jump to source discovery: ${JSON.stringify(check.steps)}`,
    );
});

test('actual post-merge recovery and Issue settlement stay in stage 5 before starting the next delivery', () => {
  const checks = observed.fetches.filter((item) => item.expectedStage === 5 && item.action === 'resume-sync');
  assert.ok(
    checks.some((item) => item.accepted),
    'fixture must fetch again after the first code acceptance',
  );
  for (const check of checks)
    assert.ok(
      check.steps.every((step) => step.stage === 5),
      `merge observation/Issue settlement must not reopen preparation: ${JSON.stringify(check.steps)}`,
    );
});

test('automatic continuation may enter the next delivery scope and preparation without relabeling them as settlement', () => {
  for (const expectedStage of [1, 2]) {
    const checks = observed.fetches.filter(
      (item) => item.action === 'resume-sync' && item.expectedStage === expectedStage,
    );
    assert.ok(checks.length, `fixture must perform the next delivery stage ${expectedStage}`);
    for (const check of checks)
      assert.ok(
        check.steps.every((step) => step.stage === expectedStage),
        `next delivery must retain stage ${expectedStage}: ${JSON.stringify(check.steps)}`,
      );
  }
});

test('post-acceptance Issue association and ledger persistence keep the verification phase', () => {
  assert.ok(observed.settlementSteps.some((step) => step.key === 'issue-link'));
  const misplaced = observed.settlementSteps.filter((step) => step.stage !== 5);
  assert.deepEqual(
    misplaced,
    [],
    'post-merge Issue association and persistence are verification evidence, not new preparation/publication',
  );
});

test('the user step set is stable from task admission; nested command phases remain evidence rather than growing the plan', () => {
  assert.ok(observed.nested.length, 'fixture must contain actual parentId command evidence');
  const unexpected = [...observed.finalUserSteps].filter((key) => !observed.initialUserSteps.has(key));
  assert.deepEqual(
    unexpected,
    [],
    'execution must update predeclared user steps, not add each new low-level command as a sibling',
  );
});

test('automatic delivery handoff identifies the new PR and does not inherit the preceding delivery expansion', () => {
  assert.equal(observed.oldDelivery.status, 'COMPLETE');
  assert.equal(observed.newDelivery.source.number, 2);
  assert.match(
    observed.banner,
    /PR\s*#2/,
    'round status must identify the active delivery after automatic continuation',
  );
  assert.equal(
    observed.manualSurvivedReload,
    true,
    'manual expansion must survive refresh within one delivery',
  );
  assert.equal(
    observed.newDeliveryInheritedOldExpansion,
    false,
    'manual expansion from the old delivery must not affect the next one',
  );
});

test('stage expansion is user-controlled and a collapsed current stage survives refresh and polling', () => {
  assert.equal(
    observed.defaultCollapsed,
    true,
    'all five stages start closed, including the current review stage',
  );
  assert.equal(observed.bulkControlsWork, true, 'expand-all and collapse-all update every stage');
  assert.equal(
    observed.manualCollapseSurvivedReload,
    true,
    'a manually collapsed current stage remains closed after refresh',
  );
  assert.equal(
    observed.manualCollapseSurvivedPolling,
    true,
    'background polling does not reopen a manually collapsed stage',
  );
  assert.equal(observed.desktopNoHorizontalOverflow, true);
  assert.equal(observed.mobileNoHorizontalOverflow, true);
});

test('a real nested command failure stays visible on its fixed business step without becoming another top-level user step', () => {
  assert.equal(observed.failedTask.status, 'FAILED');
  assert.ok(
    observed.failedTask.steps.some(
      (step) => step.key === 'git-command-evidence' && step.parentId && step.status === 'FAILED',
    ),
  );
  assert.match(observed.failureHtml, /data-step-key="candidate-check"[^>]*data-operation-state="FAILED"/);
  assert.doesNotMatch(observed.failureHtml, /data-step-key="git-command-evidence"/);
  const row = observed.failureHtml.match(
    /<li data-step-key="candidate-check"[\s\S]*?(?=<li data-step-key=|<\/ol>)/,
  )?.[0];
  assert.ok(row, 'the owning business step must remain in the fixed plan');
  assert.match(
    row.split('<details ')[0],
    /×[\s\S]*error-guide/,
    'failure guidance must be visible before folded command evidence',
  );
  assert.match(
    row,
    /只读 Git 命令细节/,
    'unknown child command evidence must stay under its actual business parent',
  );
  assert.match(
    observed.liveFailureHtml,
    /data-step-key="candidate-check"[^>]*data-operation-state="FAILED"/,
    'a failed child must not be hidden while its enclosing task is still running',
  );
});
