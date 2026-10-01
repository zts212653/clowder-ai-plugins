import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { validateCompanionReply } from '@clowder-ai/plugin-contract';
import { fixture, previewMime } from '../scripts/preview.mjs';

test('the actual renderer preview emits current Host state and conversation replies', async () => {
  assert.equal(previewMime['.webm'], 'video/webm', 'living clips must not turn into preview-only 404 fallbacks');
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
  const settings = await window.clowderCompanion.request({ kind: 'settings.read' });
  const transcript = await window.clowderCompanion.request({ kind: 'transcript.read' });
  assert.equal(validateCompanionReply(state), true, 'preview state must satisfy the installed bridge');
  assert.equal(validateCompanionReply(conversation), true, 'preview history must satisfy the installed bridge');
  assert.equal(validateCompanionReply(settings), true, 'preview settings must satisfy the installed bridge');
  assert.equal(validateCompanionReply(transcript), true, 'preview transcript must satisfy the installed bridge');
  for (const command of [
    { kind: 'prepare' },
    { kind: 'decisions.read', offset: 0, limit: 10 },
    { kind: 'documents', allowed: false },
  ]) {
    const reply = await window.clowderCompanion.request(command);
    assert.equal(validateCompanionReply(reply), true, `${command.kind} preview reply must satisfy the installed bridge`);
    if (command.kind === 'decisions.read') {
      assert.equal(reply.status, 'partial');
      assert.equal('totalCount' in reply, false, 'partial preview must not invent an exact total');
      assert.equal(reply.page.scope, 'known_rows');
    }
  }
});

test('the visual fixture can expose idle motion without inventing a pending decision', async () => {
  const window = { addEventListener() {} };
  const script = fixture('xianxian-codex', false, false).replace(/^<script>/u, '').replace(/<\/script>$/u, '');
  runInNewContext(script, { window, parent: { postMessage() {} }, location: { origin: 'http://127.0.0.1:3891' }, setTimeout() {} });
  const decisions = await window.clowderCompanion.request({ kind: 'decisions.read', offset: 0, limit: 10 });
  assert.equal(validateCompanionReply(decisions), true);
  assert.equal(decisions.approvalCount + decisions.otherNeedsMeCount, 0);
});
