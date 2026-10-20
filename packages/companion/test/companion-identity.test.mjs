import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentCompanionIdentity, historicalCompanionIdentity } from '../src/companion-identity.mjs';

const state = {
  displayName: '旧配置名字',
  duty: { catId: 'fable-5', displayName: '宪宪' },
  carrier: { catId: 'codex6-sol', displayName: '砚砚' },
  skin: 'xianxian-codex',
  liveTransport: { kind: 'gpt_live_v3', verifiedModel: null },
};

test('current companion identity follows explicit duty selection, not carrier or configurable title', () => {
  const current = currentCompanionIdentity(state);
  assert.equal(current.title, '猫猫球');
  assert.equal(current.avatarCatId, 'fable-5');
  assert.equal(current.skin, 'xianxian-codex');
  assert.equal(current.partnerLabel, '宪宪陪伴中');
  assert.equal(current.liveLabel, 'Live 快端：砚砚 · 型号未核实');
  assert.equal(current.deepLabel, '深思端：宪宪 · 型号未核实');
  assert.equal(currentCompanionIdentity({ ...state, carrier: { catId: 'other', displayName: '后台猫' } }).avatarCatId, 'fable-5');
});

test('history uses the saved identity and leaves the real author separate after a switch', () => {
  const snapshot = {
    v: 1, name: '猫猫球',
    partner: { catId: 'fable-5', displayName: '宪宪', skin: 'xianxian-codex' },
    live: { catId: 'codex6-sol', displayName: '砚砚', transport: 'gpt_live_v3', verifiedModel: null },
    deep: { catId: 'fable-5', displayName: '宪宪', verifiedModel: null },
  };
  const switched = currentCompanionIdentity({ ...state, duty: { catId: 'codex6-sol', displayName: '砚砚' }, skin: 'yanyan-codex' });
  const old = historicalCompanionIdentity(snapshot, '砚砚');
  assert.equal(switched.avatarCatId, 'codex6-sol');
  assert.equal(old.avatarCatId, 'fable-5');
  assert.equal(old.partnerLabel, '当时由宪宪陪伴');
  assert.equal(old.authorLabel, '砚砚');
});

test('legacy or forged history does not borrow the currently selected companion', () => {
  assert.deepEqual(historicalCompanionIdentity(undefined, '砚砚'), { authorLabel: '砚砚', companionKnown: false });
  assert.deepEqual(historicalCompanionIdentity({ v: 1, name: '猫猫球' }, '砚砚'), { authorLabel: '砚砚', companionKnown: false });
});
