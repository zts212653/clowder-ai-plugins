import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCompanionCommand, validateCompanionReply } from '@clowder-ai/plugin-contract';
import { DESK_SCENARIOS, fixture, previewDeskAvatar, previewDeskThumbnail, previewMime } from '../scripts/preview.mjs';

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
  const conversationV2 = await window.clowderCompanion.request({ kind: 'conversation.read', v: 2 });
  const settings = await window.clowderCompanion.request({ kind: 'settings.read' });
  const transcript = await window.clowderCompanion.request({ kind: 'transcript.read' });
  const draft = await window.clowderCompanion.request({ kind: 'conversation.draft.read', v: 1 });
  const savedDraft = await window.clowderCompanion.request({
    kind: 'conversation.draft.save', v: 1, scopeRef: draft.scopeRef,
    expectedRevision: draft.revision, text: '预览递信',
  });
  const delivery = await window.clowderCompanion.request({
    kind: 'text', v: 2, scopeRef: savedDraft.scopeRef, text: savedDraft.text,
    clientMessageId: '11111111-1111-4111-8111-111111111111',
    submissionRevision: savedDraft.revision,
  });
  assert.equal(validateCompanionReply(state), true, 'preview state must satisfy the installed bridge');
  assert.equal(validateCompanionReply(conversation), true, 'preview history must satisfy the installed bridge');
  assert.equal(validateCompanionReply(conversationV2), true, 'preview v2 history must satisfy the installed bridge');
  assert.equal(validateCompanionReply(settings), true, 'preview settings must satisfy the installed bridge');
  assert.equal(validateCompanionReply(transcript), true, 'preview transcript must satisfy the installed bridge');
  assert.equal(validateCompanionReply(draft), true, 'preview draft must satisfy the installed bridge');
  assert.equal(validateCompanionReply(savedDraft), true, 'preview draft save must satisfy the installed bridge');
  assert.equal(validateCompanionReply(delivery), true, 'preview v2 delivery must satisfy the installed bridge');
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

test('desk preview scenarios speak the exact bridge for state, settlement and thumbnail replies', async () => {
  const thumbnail = { mediaType: 'image/png', dataBase64: 'AAAA', width: 1024, height: 659 };
  const avatar = { mediaType: 'image/png', dataBase64: 'BBBB', width: 128, height: 128 };
  for (const scenario of DESK_SCENARIOS) {
    const window = { addEventListener() {}, setTimeout() {} };
    const script = fixture('xianxian-codex', false, true, true, false, { scenario, more: 2, thumbnail, avatar })
      .replace(/^<script>/u, '').replace(/<\/script>$/u, '');
    runInNewContext(script, { window, parent: { postMessage() {} }, location: { origin: 'http://127.0.0.1:3891' }, setTimeout() {} });
    const request = command => {
      assert.equal(validateCompanionCommand(command), true, JSON.stringify(command));
      return window.clowderCompanion.request(command);
    };
    const state = await request({ kind: 'state' });
    assert.equal(validateCompanionReply(state), true, `${scenario} state`);
    const { scopeRef, delivery } = state.desk;
    assert.equal(delivery.mode, scenario === 'bundle' ? 'bundle' : 'single');
    assert.equal(delivery.from.role, 'watcher');
    if (scenario === 'bundle') {
      assert.deepEqual(JSON.parse(JSON.stringify(delivery.items.map(item => [item.kind, item.source.conversationTitle]))),
        [['work', '「视频」自媒体视频运营'], ['work', '守望猫'], ['suggestion', '守望猫']]);
      assert.equal(delivery.more, 2);
    } else {
      assert.equal(delivery.items[0].sentence, '鲸鲸那三格，照他的头像画就行。');
      assert.equal(delivery.items[0].title, '六猫岛 · 单采肖像参考');
    }
    const [first] = delivery.items;
    const image = await request({ kind: 'desk.thumbnail.read', scopeRef, deliveryRef: delivery.deliveryRef, itemRef: first.itemRef });
    assert.equal(validateCompanionReply(image), true);
    assert.deepEqual({ ...image.image }, thumbnail);
    const face = await request({ kind: 'desk.avatar.read', scopeRef, deliveryRef: delivery.deliveryRef });
    assert.equal(validateCompanionReply(face), true);
    assert.deepEqual({ ...face.image }, avatar);
    const replies = [
      await request({ kind: 'desk.settle', scopeRef, deliveryRef: delivery.deliveryRef, action: 'shown' }),
      await request({ kind: 'desk.settle', scopeRef, deliveryRef: delivery.deliveryRef, action: first.action, itemRef: first.itemRef }),
      await request({ kind: 'desk.settle', scopeRef, deliveryRef: delivery.deliveryRef, action: 'timeout' }),
      await request({ kind: 'desk.settle', scopeRef, deliveryRef: delivery.deliveryRef, action: 'dismiss' }),
    ];
    for (const reply of replies) assert.equal(validateCompanionReply(reply), true, JSON.stringify(reply));
    assert.deepEqual(JSON.parse(JSON.stringify(replies.map(reply => reply.outcome))), ['settled', 'settled', 'settled', 'stale_delivery']);
    assert.equal(replies[2].saved, true);
    assert.equal(validateCompanionReply(await request({ kind: 'state' })), true, 'state after settling');
  }
});

test('the preview reads a local thumbnail into the bridge bound without exposing its path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-desk-preview-'));
  try {
    const png = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.writeUInt32BE(2200, 16);
    png.writeUInt32BE(1416, 20);
    await writeFile(join(directory, 'cover.png'), png);
    const thumbnail = await previewDeskThumbnail(join(directory, 'cover.png'));
    assert.deepEqual({ ...thumbnail, dataBase64: undefined }, { mediaType: 'image/png', dataBase64: undefined, width: 1024, height: 659 });
    assert.equal(Buffer.from(thumbnail.dataBase64, 'base64').equals(png), true);
    assert.equal(await previewDeskThumbnail(join(directory, 'missing.png')), null);
    const face = await previewDeskAvatar(join(directory, 'cover.png'));
    assert.deepEqual([face.width, face.height], [256, 165], 'avatars are reported inside the 256px bound');
    assert.equal(await previewDeskThumbnail(undefined), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
