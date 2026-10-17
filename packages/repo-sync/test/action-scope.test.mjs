import assert from 'node:assert/strict';
import test from 'node:test';
import { guardRenderedScope, snapshotIdentity } from '../web/action-scope.mjs';
import { rememberExpansion, restoreExpansion, setAllExpansion } from '../web/expansion.mjs';

test('rendered action identity rejects another delivery, run, target or configuration', () => {
  const snapshot = {
    config: { bindingId: 'binding' },
    connection: { revision: 'r1' },
    state: {
      active: { id: 'delivery1' },
      automation: { id: 'run1' },
      queue: [{ target: 'a' }],
    },
  };
  const frozen = snapshotIdentity(snapshot);
  for (const mutate of [
    (s) => {
      s.state.active.id = 'delivery2';
    },
    (s) => {
      s.state.automation.id = 'run2';
    },
    (s) => {
      s.state.queue[0].target = 'b';
    },
    (s) => {
      s.connection.revision = 'r2';
    },
  ]) {
    const next = structuredClone(snapshot);
    mutate(next);
    assert.notEqual(snapshotIdentity(next), frozen);
  }
  snapshot.operation = { status: 'RUNNING' };
  assert.equal(snapshotIdentity(snapshot), frozen);
});
test('stale rendered forms cannot bypass the guard through direct authentication handlers', () => {
  const handlers = new Map();
  globalThis.document = {
    addEventListener: (kind, handler, capture) => {
      assert.equal(capture, true);
      handlers.set(kind, handler);
    },
  };
  try {
    const snapshot = { connection: { revision: 'new' } };
    let blocks = 0;
    guardRenderedScope(
      { dataset: { actionScope: 'old' }, contains: () => true },
      () => snapshot,
      () => blocks++,
    );
    for (const kind of ['click', 'submit']) {
      let prevented = false,
        stopped = false;
      handlers.get(kind)({
        target: { dataset: { secretForm: '' } },
        preventDefault: () => {
          prevented = true;
        },
        stopImmediatePropagation: () => {
          stopped = true;
        },
      });
      assert.ok(prevented && stopped);
    }
    assert.equal(blocks, 2);
  } finally {
    delete globalThis.document;
  }
});
test('expand-all is persisted for this delivery and remains open on a polling update', () => {
  const values = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  try {
    const stages = [1, 2, 3, 4, 5].map((id) => ({
      dataset: { stage: String(id), stageState: id < 4 ? 'done' : 'current' },
      open: true,
    }));
    const content = {
      querySelectorAll: (selector) => selector === '[data-stage]' ? stages : [],
      querySelector: () => null,
    };
    rememberExpansion('delivery1', Object.fromEntries(stages.map((stage) => [stage.dataset.stage, true])));
    const snapshot = {
      config: { mode: 'continuous' },
      state: {
        active: {
          id: 'd1',
          status: 'WAITING_APPROVAL',
          prUrl: 'https://example.com/pr/1',
        },
        automation: { status: 'WAITING_REVIEW' },
      },
    };
    restoreExpansion(content, snapshot, 'current', 'delivery1');
    assert.ok(stages.every((stage) => stage.open));
    restoreExpansion(content, snapshot, 'current', 'delivery2');
    assert.equal(stages[0].open, false);
  } finally {
    delete globalThis.sessionStorage;
  }
});

test('all workflow stages start collapsed, including the active and failed stage', () => {
  const values = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  try {
    const stages = [1, 2, 3, 4, 5].map((id) => ({
      dataset: {
        stage: String(id),
        stageState: id === 3 ? 'current' : id === 2 ? 'failed' : 'pending',
      },
      open: true,
    }));
    const content = {
      querySelectorAll: (selector) => selector === '[data-stage]' ? stages : [],
      querySelector: () => null,
    };
    const snapshot = {
      config: { mode: 'continuous' },
      state: {
        active: { id: 'd1', status: 'CODE_PREPARE_REQUIRED', candidate: 'abc' },
        automation: { status: 'RUNNING' },
      },
    };
    restoreExpansion(content, snapshot, 'current', 'delivery1');
    assert.ok(stages.every((stage) => stage.open === false));
  } finally {
    delete globalThis.sessionStorage;
  }
});

test('a manually collapsed current or failed stage stays collapsed across state refreshes', () => {
  const values = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  try {
    const stage = {
      dataset: { stage: '2', stageState: 'current' },
      open: true,
    };
    const content = { querySelectorAll: () => [stage] };
    const snapshot = {
      config: { mode: 'version' },
      state: { active: { id: 'd1', status: 'CODE_PREPARE_REQUIRED' } },
    };
    rememberExpansion('delivery1', { 2: false });
    restoreExpansion(content, snapshot, 'current', 'delivery1');
    assert.equal(stage.open, false);
    stage.dataset.stageState = 'failed';
    restoreExpansion(content, snapshot, 'current', 'delivery1');
    assert.equal(stage.open, false);
  } finally {
    delete globalThis.sessionStorage;
  }
});

test('expand-all and collapse-all both persist a complete per-stage state map', () => {
  const values = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  try {
    const stages = [1, 2, 3, 4, 5].map((id) => ({
      dataset: { stage: String(id) },
      open: false,
    }));
    const step = { hidden: true }, hint = { hidden: false }, node = {
      selected: 'true', setAttribute(_name, value) { this.selected = value; },
    };
    const content = {
      querySelectorAll: (selector) => selector === '[data-stage]' ? stages : selector === '[data-step-key]' ? [step] : selector === '.flow-child-disclosure' ? [] : [node],
      querySelector: () => hint,
    };
    rememberExpansion('delivery1', { 'flow:selection': { stage: '4', node: 'merge-readiness' } });
    setAllExpansion(content, 'delivery1', true);
    assert.ok(stages.every((stage) => stage.open));
    assert.equal(step.hidden, false);
    assert.equal(node.selected, 'false');
    assert.equal(hint.hidden, true);
    assert.deepEqual(JSON.parse(values.get('delivery1')), {
      1: true,
      2: true,
      3: true,
      4: true,
      5: true,
      'flow:selection': null,
    });
    setAllExpansion(content, 'delivery1', false);
    assert.ok(stages.every((stage) => !stage.open));
    assert.equal(hint.hidden, false);
    assert.deepEqual(JSON.parse(values.get('delivery1')), {
      1: false,
      2: false,
      3: false,
      4: false,
      5: false,
      'flow:selection': null,
    });
  } finally {
    delete globalThis.sessionStorage;
  }
});
