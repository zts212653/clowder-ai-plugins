import assert from 'node:assert/strict';
import test from 'node:test';
import { nextAction } from '../web/action-policy.mjs';

const d = { id: 'a'.repeat(24), mode: 'version', status: 'CODE_PREPARE_REQUIRED', issues: [] };
const snapshot = { state: { issues: {} }, platform: { repositoryUrl: 'https://codehub.example/core' } };
test('action guidance never turns unknown status, PR correction, or history into generic re-execution', () => {
  assert.equal(nextAction(snapshot, { ...d, status: 'FUTURE' }).action, undefined);
  assert.equal(
    nextAction(snapshot, { ...d, status: 'PR_REQUIRED', error: { code: 'PR_URL_MISMATCH' } }).anchor,
    'pr-form',
  );
  assert.equal(nextAction(snapshot, d, true).action, undefined);
  assert.equal(nextAction(snapshot, { ...d, error: { code: 'INTERNAL_PATH_COLLISION' } }).stage, 2);
  assert.equal(nextAction(snapshot, { ...d, status: 'PUSH_RESULT_UNKNOWN' }).action, 'recover');
});
test('stop uncertainty and record persistence take priority over otherwise valid business actions', () => {
  const task = { deliveryId: d.id, status: 'STOP_UNCONFIRMED', steps: [] };
  assert.equal(nextAction({ ...snapshot, operation: task }, d).action, undefined);
  const persistence = { status: 'FAILED', canRetry: true };
  assert.equal(
    nextAction({ ...snapshot, operation: { ...task, status: 'SUCCEEDED', persistence } }, d).special,
    'persist-operation',
  );
  assert.equal(nextAction({ ...snapshot, operation: { ...task, persistence } }, d, true).special, undefined);
});
