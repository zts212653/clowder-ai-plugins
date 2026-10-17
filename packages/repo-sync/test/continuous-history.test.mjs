import assert from 'node:assert/strict';
import test from 'node:test';
import { recordList } from '../src/records.mjs';

test('continuous history searches and returns the frozen target without renaming its individual PR identities', async () => {
  const target = { kind: 'tag', value: 'v2.0.0', commit: 'a'.repeat(40) };
  const deliveries = [1, 2].map((number) => ({
    id: String(number).repeat(24),
    mode: 'continuous',
    source: { number, title: `PR ${number}` },
    syncTarget: target,
    status: 'COMPLETE',
    target: 'b'.repeat(40),
  }));
  const before = JSON.stringify(deliveries);
  const receiver = { config: { bindingId: 'binding' }, status: async () => ({ deliveries }) };
  const result = await recordList(receiver, new URLSearchParams('q=v2.0.0'));
  assert.equal(result.total, 2);
  assert.deepEqual(
    result.records.map((item) => item.source.number),
    [2, 1],
  );
  assert.equal(result.records[0].syncTarget.commit, target.commit);
  assert.equal(result.records[0].source.tag, undefined);
  assert.equal(JSON.stringify(deliveries), before);
});
