import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { validateCompanionReply } from '@clowder-ai/plugin-contract';
import { fixture } from '../scripts/preview.mjs';

test('the actual renderer preview emits current Host state and conversation replies', async () => {
  const window = { addEventListener() {} };
  const script = fixture('xianxian-codex', false).replace(/^<script>/u, '').replace(/<\/script>$/u, '');
  runInNewContext(script, {
    window,
    parent: { postMessage() {} },
    location: { origin: 'http://127.0.0.1:3891' },
    setTimeout() {},
  });
  const state = await window.clowderCompanion.request({ kind: 'state' });
  const conversation = await window.clowderCompanion.request({ kind: 'conversation.read' });
  assert.equal(validateCompanionReply(state), true, 'preview state must satisfy the installed bridge');
  assert.equal(validateCompanionReply(conversation), true, 'preview history must satisfy the installed bridge');
  for (const command of [
    { kind: 'prepare' },
    { kind: 'decisions.read', offset: 0, limit: 10 },
    { kind: 'documents', allowed: false },
  ]) {
    const reply = await window.clowderCompanion.request(command);
    assert.equal(validateCompanionReply(reply), true, `${command.kind} preview reply must satisfy the installed bridge`);
  }
});
