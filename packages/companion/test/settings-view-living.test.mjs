import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SettingsView } from '../src/settings-view.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const values = {
  dutyCatProfileId: 'fable-5', skin: 'xianxian-codex', ballSize: 72, behaviorEnabled: true, proactivePolicy: 'quiet-badge',
  personaTone: '温暖', householdReadsAllowed: true, appAssistEnabled: false,
};

/** The settings page against a Host stand-in that saves what it is asked and reads it back. */
function fixture({ livingBody }) {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, hidden: false, dataset: {}, textContent: '', value: '', style: {},
      setAttribute() {}, querySelectorAll: () => [], replaceChildren() {}, append() {} });
    return nodes.get(id);
  };
  const document = { getElementById: node, createElement: () => node(Symbol('row')) };
  let saved = { ...values };
  const updates = [];
  const client = {
    readSettings: async () => ({ kind: 'settings', status: 'available', values: saved,
      companions: [{ catProfileId: 'fable-5', displayName: '宪宪', available: true }], selectedCompanionStatus: 'available' }),
    updateSetting: async (field, value) => {
      updates.push([field, value]);
      saved = { ...saved, [field]: value };
      return { kind: 'settings-update', field, outcome: 'saved', callStatus: 'unchanged', applies: 'now' };
    },
  };
  const seen = [];
  const view = new SettingsView({ document, client, livingBody, close() {}, callActive: () => false,
    onValues: next => seen.push(next.skin) });
  return { view, nodes, updates, seen };
}

test('the living cat is offered only by a package on the livingBody contract line', async () => {
  const older = fixture({ livingBody: false });
  await older.view.open(); await flush();
  assert.equal(older.nodes.get('settings-skin-xianxian-living').hidden, true, 'another line keeps the option hidden');
  for (const id of ['xianxian-codex', 'yanyan-codex', 'ragdoll-v1', 'yarn-ball'])
    assert.equal(older.nodes.get(`settings-skin-${id}`).hidden, false, id);

  const living = fixture({ livingBody: true });
  await living.view.open(); await flush();
  assert.equal(living.nodes.get('settings-skin-xianxian-living').hidden, false);
  living.nodes.get('settings-look-open').onclick();
  living.nodes.get('settings-skin-xianxian-living').onclick(); await flush();
  assert.deepEqual(living.updates, [['skin', 'xianxian-living']], 'choosing it saves through the ordinary settings path');
  assert.equal(living.nodes.get('settings-look-value').textContent, '宪宪（活猫）');
  assert.equal(living.nodes.get('settings-skin-xianxian-living').dataset.selected, 'true');
  assert.equal(living.nodes.get('settings-notice').textContent, '外观已保存');
  assert.equal(living.seen.at(-1), 'xianxian-living', 'the panel learns the saved body at once');

  living.nodes.get('settings-skin-yarn-ball').onclick(); await flush();
  assert.deepEqual(living.updates.at(-1), ['skin', 'yarn-ball'], 'another skin switches back');
  assert.equal(living.nodes.get('settings-skin-xianxian-living').dataset.selected, 'false');
  assert.equal(living.seen.at(-1), 'yarn-ball');
});

