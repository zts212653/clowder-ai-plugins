import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPluginOwnerThread, assertPluginOwnerThreadCreateInput, assertPluginOwnerThreadAddParticipantsInput } from './owner-threads.js';

test('owner thread data contains only the strict owner projection, not generic navigation or authority', () => {
  assertPluginOwnerThread({ id: 'thread', createdBy: 'owner', participants: Array.from({ length: 60 }, (_, i) => `cat-${i}`) });
  for (const value of [null, { id: 'thread', participants: [] },
    { id: 'thread', createdBy: 'owner', participants: [], authority: true },
    { id: 'thread', createdBy: 'owner', participants: [], deepLinkUrl: '/thread' }]) {
    assert.throws(() => assertPluginOwnerThread(value), /Invalid PluginOwnerThread/);
  }
});

test('owner thread create accepts only the actual bounded title input', () => {
  assertPluginOwnerThreadCreateInput({ title: 'x'.repeat(200) });
  for (const value of [{ title: '' }, { title: ' trailing ' }, { title: 'x'.repeat(201) },
    { title: 'trailing\n' }, { title: '😀'.repeat(101) },
    { title: 'Owner thread', ownerUserId: 'forged' }, { title: 'Owner thread', projectPath: '/tmp' }]) {
    assert.throws(() => assertPluginOwnerThreadCreateInput(value), /PluginOwnerThreadCreateInput/);
  }
});

test('owner thread participant input mirrors the fifty unique string limit without granting roster eligibility', () => {
  assertPluginOwnerThreadAddParticipantsInput({ threadId: 'thread', catIds: [] });
  assertPluginOwnerThreadAddParticipantsInput({ threadId: 'x'.repeat(500), catIds: Array.from({ length: 50 }, (_, i) => `cat-${i}`) });
  for (const value of [{ threadId: 'thread ', catIds: [] }, { threadId: 'x'.repeat(501), catIds: [] },
    { threadId: '😀'.repeat(251), catIds: [] },
    { threadId: 'thread', catIds: ['cat', 'cat'] }, { threadId: 'thread', catIds: [12] },
    { threadId: 'thread', catIds: Array.from({ length: 51 }, (_, i) => `cat-${i}`) },
    { threadId: 'thread', catIds: [], ownerUserId: 'forged' }]) {
    assert.throws(() => assertPluginOwnerThreadAddParticipantsInput(value), /PluginOwnerThreadAddParticipantsInput/);
  }
});
