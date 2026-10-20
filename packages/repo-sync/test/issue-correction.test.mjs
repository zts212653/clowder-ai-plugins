import assert from 'node:assert/strict';
import test from 'node:test';
import { Receiver } from '../src/engine.mjs';
import { repositories } from './fixtures.mjs';

test('unused Issue reference can be corrected, but frozen code or existing receipts prohibit replacement', async () => {
  const f = await repositories();
  const receiver = new Receiver(f.config);
  await receiver.adopt(f.u0, f.i0);
  await receiver.setQueue(f.plans);
  await receiver.start();
  await receiver.linkIssue('issue-71', '999', 'https://codehub.example/core/issues/999');
  await receiver.linkIssue('issue-71', '318', 'https://codehub.example/core/issues/318', {
    previousId: '999',
    previousUrl: 'https://codehub.example/core/issues/999',
  });
  assert.equal((await receiver.status()).issues['issue-71'].internalId, '318');
  assert.equal((await receiver.status()).issues['issue-71'].history[0].internalId, '999');
  await receiver.prepare();
  await assert.rejects(
    () =>
      receiver.linkIssue('issue-71', '400', 'https://codehub.example/core/issues/400', {
        previousId: '318',
        previousUrl: 'https://codehub.example/core/issues/318',
      }),
    { code: 'ISSUE_MAPPING_FROZEN' },
  );
});
