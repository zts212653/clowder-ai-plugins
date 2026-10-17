import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPluginParticipant, assertPluginParticipantWithAvailability, assertPluginParticipantRosterInput } from './participant-roster.js';
test('participant DTO retains public required and optional fields without inventing eligible authority', () => {
  const row = { catId: 'cat', displayName: 'Cat', defaultModel: 'model', supported: false };
  assertPluginParticipant(row);
  assertPluginParticipant({ ...row, nickname: 'Kit', variantLabel: 'Sol', roleDescription: 'Role', avatar: 'data:image/webp;base64,UklGRg==' });
  for (const value of [{ ...row, supported: 'true' }, { ...row, available: true }, { ...row, eligible: true },
    { ...row, policy: {} }, { ...row, avatar: '/private/file.webp' }, { ...row, avatar: 'data:image/webp;base64,' + 'A'.repeat(1200) }]) {
    assert.throws(() => assertPluginParticipant(value), /PluginParticipant/);
  }
});
test('participant roster input is exactly the bounded UTF16 trim-equal contribution coordinate', () => {
  assertPluginParticipantRosterInput({ contributionId: 'x'.repeat(256) });
  for (const value of [{ contributionId: '' }, { contributionId: 'x'.repeat(257) }, { contributionId: '😀'.repeat(129) },
    { contributionId: 'native\n' }, { contributionId: 'native', method: 'forged' }, { contributionId: 'native', instanceId: 'forged' }]) {
    assert.throws(() => assertPluginParticipantRosterInput(value), /PluginParticipantRosterInput/);
  }
});


test('participant roster quota is requested only by explicit true opt-in and never accepts authority selectors', () => {
  assertPluginParticipantRosterInput({ contributionId: 'native', includeAvailability: true });
  for (const value of [{ contributionId: 'native', includeAvailability: false }, { contributionId: 'native', includeAvailability: undefined },
    { contributionId: 'native', includeAvailability: true, ownerUserId: 'forged' }, { contributionId: 'native', includeAvailability: true, methods: ['forged'] }]) {
    assert.throws(() => assertPluginParticipantRosterInput(value), /PluginParticipantRosterInput/);
  }
});


test('opt-in quota participant shape is bounded and required while legacy participants remain strict', () => {
  const row = { catId: 'cat', displayName: 'Cat', defaultModel: 'model', supported: false };
  assertPluginParticipantWithAvailability({ ...row, available: true });
  assertPluginParticipantWithAvailability({ ...row, available: false });
  for (const value of [row, { ...row, available: 'true' }, { ...row, available: true, grantRef: 'forged' }]) {
    assert.throws(() => assertPluginParticipantWithAvailability(value), /PluginParticipantWithAvailability/);
  }
  assert.throws(() => assertPluginParticipant({ ...row, available: true }), /PluginParticipant/);
});
