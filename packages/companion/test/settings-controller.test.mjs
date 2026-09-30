import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SettingsController } from '../src/settings-controller.mjs';

const values = (overrides = {}) => ({
  dutyCatProfileId: 'fable-5',
  skin: 'xianxian-codex',
  ballSize: 72,
  behaviorEnabled: true,
  proactivePolicy: 'quiet-badge',
  personaTone: '温暖、简短、不啰嗦',
  householdReadsAllowed: true,
  ...overrides,
});
const settings = (overrides = {}) => ({
  kind: 'settings', status: 'available', values: values(),
  companions: [
    { catProfileId: 'fable-5', displayName: '宪宪', available: true },
    { catProfileId: 'codex-sol', displayName: '砚砚', available: true },
    { catProfileId: 'gemini38', displayName: '烁烁', available: false },
  ],
  selectedCompanionStatus: 'available',
  ...overrides,
});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(overrides = {}) {
  const calls = [], states = [];
  let current = settings();
  const client = {
    readSettings: async () => { calls.push(['read']); return current; },
    updateSetting: async (field, value) => {
      calls.push(['update', field, value]);
      current = { ...current, values: { ...current.values, [field]: value } };
      return { kind: 'settings-update', field, outcome: 'saved', callStatus: 'unchanged',
        applies: field === 'personaTone' ? 'next_call' : 'now' };
    },
    resetPosition: async () => { calls.push(['reset']); return { kind: 'ok' }; },
    disableCompanion: async () => { calls.push(['disable']); return { kind: 'companion-lifecycle', action: 'disable', outcome: 'disabled' }; },
    ...overrides,
  };
  const controller = new SettingsController({ client, changed: state => states.push(structuredClone(state)) });
  return { controller, calls, states, setCurrent: value => { current = value; } };
}

test('settings read preserves unavailable saved selection instead of choosing the first cat', async () => {
  const f = fixture({ readSettings: async () => {
    f.calls.push(['read']);
    return settings({ values: values({ dutyCatProfileId: 'retired-cat' }), selectedCompanionStatus: 'unavailable' });
  } });
  await f.controller.load();
  assert.equal(f.controller.state.phase, 'ready');
  assert.equal(f.controller.state.values.dutyCatProfileId, 'retired-cat');
  assert.equal(f.controller.state.selectedCompanionStatus, 'unavailable');
});

test('a pure preference saves once, reads back canonical truth, and reports immediate application', async () => {
  const f = fixture();
  await f.controller.load();
  await f.controller.requestUpdate('behaviorEnabled', false);
  assert.deepEqual(f.calls, [['read'], ['update', 'behaviorEnabled', false], ['read']]);
  assert.equal(f.controller.state.values.behaviorEnabled, false);
  assert.deepEqual(f.controller.state.notice, {
    kind: 'saved', field: 'behaviorEnabled', callStopped: false, applies: 'now',
  });
});

test('a call-sensitive change waits for confirmation and never restarts after stop-then-save failure', async () => {
  const f = fixture({
    updateSetting: async (field, value) => {
      f.calls.push(['update', field, value]);
      return { kind: 'settings-update', field, outcome: 'rejected', callStatus: 'stopped', reason: 'save_failed' };
    },
  });
  await f.controller.load();
  await f.controller.requestUpdate('householdReadsAllowed', false, { confirm: true });
  assert.deepEqual(f.calls, [['read']]);
  assert.equal(f.controller.state.page, 'confirm');
  assert.equal(f.controller.state.confirmation.field, 'householdReadsAllowed');

  await f.controller.confirm();
  assert.deepEqual(f.calls, [['read'], ['update', 'householdReadsAllowed', false], ['read']]);
  assert.equal(f.controller.state.values.householdReadsAllowed, true);
  assert.deepEqual(f.controller.state.notice, {
    kind: 'rejected', field: 'householdReadsAllowed', callStopped: true, reason: 'save_failed',
  });
  assert.equal(f.calls.some(([kind]) => ['prepare', 'connect'].includes(kind)), false);
});

test('unknown settlement is resolved by readback and never automatically replays the update', async () => {
  let current = settings();
  const f = fixture({
    updateSetting: async (field, value) => {
      f.calls.push(['update', field, value]);
      current = { ...current, values: { ...current.values, [field]: value } };
      return { kind: 'settings-update', field, outcome: 'unconfirmed', callStatus: 'unchanged', reconcile: 'settings.read' };
    },
    readSettings: async () => { f.calls.push(['read']); return current; },
  });
  await f.controller.load();
  await f.controller.requestUpdate('skin', 'yanyan-codex');
  assert.equal(f.calls.filter(([kind]) => kind === 'update').length, 1);
  assert.equal(f.controller.state.values.skin, 'yanyan-codex');
  assert.deepEqual(f.controller.state.notice, {
    kind: 'reconciled_saved', field: 'skin', callStopped: false,
  });
});

test('unknown settlement that reads back the old value stays not-saved without retry', async () => {
  const f = fixture({
    updateSetting: async (field, value) => {
      f.calls.push(['update', field, value]);
      return { kind: 'settings-update', field, outcome: 'unconfirmed', callStatus: 'stopped', reconcile: 'settings.read' };
    },
  });
  await f.controller.load();
  await f.controller.requestUpdate('dutyCatProfileId', 'codex-sol', { confirm: true });
  await f.controller.confirm();
  assert.equal(f.calls.filter(([kind]) => kind === 'update').length, 1);
  assert.equal(f.controller.state.values.dutyCatProfileId, 'fable-5');
  assert.deepEqual(f.controller.state.notice, {
    kind: 'reconciled_not_saved', field: 'dutyCatProfileId', callStopped: true,
  });
});

test('a late settings read cannot overwrite a newer read', async () => {
  const first = deferred();
  let reads = 0;
  const f = fixture({ readSettings: async () => {
    f.calls.push(['read']);
    reads += 1;
    if (reads === 1) return first.promise;
    return settings({ values: values({ ballSize: 120 }) });
  } });
  const old = f.controller.load();
  const recent = f.controller.load();
  await recent;
  first.resolve(settings({ values: values({ ballSize: 48 }) }));
  await old;
  assert.equal(f.controller.state.values.ballSize, 120);
});

test('reset is direct but disabling the installed companion requires confirmation', async () => {
  const f = fixture();
  await f.controller.load();
  await f.controller.resetPosition();
  f.controller.requestDisable();
  assert.deepEqual(f.calls, [['read'], ['reset']]);
  assert.equal(f.controller.state.page, 'disable');
  await f.controller.confirm();
  assert.deepEqual(f.calls, [['read'], ['reset'], ['disable']]);
  assert.equal(f.controller.state.phase, 'disabled');
});
