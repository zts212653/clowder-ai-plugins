import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { dispatchConfirmedActions } from '../src/notification-recovery.mjs';
import { confirmedMoveProjection, createGame, pendingConfirmedActions, playGame, readGame, undoGame } from '../src/store.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'xiangqi-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  createGame(root, 'game');
  return root;
}

function action(root) {
  return { actionId: 'confirmed-001', bindingGeneration: 'binding-alpha', ...confirmedMoveProjection(root, readGame(root, 'game'), 'b2e2') };
}

test('committed move survives crash before notification and retries one stable action', async (t) => {
  const root = fixture(t);
  const confirmed = action(root);
  playGame(root, 'game', 'b2e2', {
    actor: 'human', expectedRevision: 0, origin: 'board', confirmedAction: confirmed,
  });
  assert.equal(readGame(root, 'game').revision, 1);
  assert.deepEqual(pendingConfirmedActions(root, 'game', 'binding-alpha').map((item) => item.actionId), [confirmed.actionId]);
  assert.deepEqual(Object.keys(pendingConfirmedActions(root, 'game', 'binding-alpha')[0]).sort(),
    ['actionId', 'bindingGeneration', 'expectedStateToken', 'objectRef', 'operationDigest', 'stateRevision']);
  let starts = 0;
  const accepted = new Map();
  const host = {
    async notifyConfirmedMove(_session, item) {
      if (!accepted.has(item.actionId)) {
        starts++;
        accepted.set(item.actionId, { actionId: item.actionId, operationDigest: item.operationDigest, receiptId: 'receipt-1' });
        throw new Error('connection died after durable accept');
      }
      assert.equal(accepted.get(item.actionId).operationDigest, item.operationDigest);
      return accepted.get(item.actionId);
    },
  };
  await assert.rejects(() => dispatchConfirmedActions(root, 'game', confirmed.bindingGeneration, { runtimeLease: 'lease-1' }, host), /connection died/);
  assert.equal(pendingConfirmedActions(root, 'game', confirmed.bindingGeneration).length, 1);
  await dispatchConfirmedActions(root, 'game', confirmed.bindingGeneration, { runtimeLease: 'lease-2' }, host);
  assert.equal(starts, 1);
  assert.deepEqual(pendingConfirmedActions(root, 'game', confirmed.bindingGeneration), []);
  assert.equal(readGame(root, 'game').moves.length, 1);
  const duplicate = playGame(root, 'game', 'b2e2', {
    actor: 'human', expectedRevision: 0, origin: 'board', confirmedAction: confirmed,
  });
  assert.equal(duplicate.duplicateAction, true);
  assert.equal(readGame(root, 'game').revision, 1);
  assert.throws(() => playGame(root, 'game', 'h2e2', {
    actor: 'human', expectedRevision: 0, origin: 'board', confirmedAction: confirmed,
  }), /actionId.*内容|内容.*actionId/);
});

test('undo and changed binding preserve history but cannot replay old confirmation', async (t) => {
  const root = fixture(t);
  const confirmed = action(root);
  assert.throws(() => playGame(root, 'game', 'b2e2', {
    actor: 'human', expectedRevision: 0, origin: 'board',
    confirmedAction: { ...confirmed, operationDigest: '0'.repeat(64) },
  }), /摘要/);
  playGame(root, 'game', 'b2e2', {
    actor: 'human', expectedRevision: 0, origin: 'board', confirmedAction: confirmed,
  });
  assert.deepEqual(pendingConfirmedActions(root, 'game', 'binding-beta'), []);
  undoGame(root, 'game', 1, 1);
  assert.deepEqual(pendingConfirmedActions(root, 'game', 'binding-alpha'), []);
  let notified = false;
  await dispatchConfirmedActions(root, 'game', 'binding-alpha', {}, {
    async notifyConfirmedMove() { notified = true; },
  });
  assert.equal(notified, false);
  assert.equal(readGame(root, 'game').events.length, 2);
});

test('a confirmation for the same position in another retained root cannot move this game', (t) => {
  const first = fixture(t);
  const second = fixture(t);
  assert.equal(readGame(first, 'game').fen, readGame(second, 'game').fen);
  assert.throws(() => playGame(second, 'game', 'b2e2', {
    actor: 'human', expectedRevision: 0, origin: 'board', confirmedAction: action(first),
  }), /摘要/);
  assert.equal(readGame(second, 'game').revision, 0);
});
