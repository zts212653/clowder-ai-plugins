import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { paired, delivery, rpc } from './fixture.mjs';

const history = JSON.parse(await readFile(new URL('./fixtures/anonymized-history.json', import.meta.url), 'utf8'));

for (const sample of history.cases) {
  test(`historical ${sample.case}: current consumer retains old result across off-mode and restart`, async (t) => {
    const f = await paired(t);
    const connection = (await f.host.storage.get('dot/connection/v1')).value;
    // Pairing identities are fixture-local. Historical field presence, result
    // identity family and event ordering are retained; no real key is replayed.
    const record = {
      ...sample.dispatch,
      ownerUserId: f.owner.userId,
      attemptId: connection.attemptId,
      agentKeyId: connection.agentKeyId,
    };
    const key = `dot/dispatch/${record.eventId}`;
    await f.host.storage.set(key, record);
    f.messages.set(record.replyMessageId, {
      ...f.source,
      id: record.replyMessageId,
      replyTo: record.sourceMessageId,
      content: sample.replyContent,
    });

    await f.active.stop({ reason: 'disabled' });
    await assert.rejects(() => f.active.deliver(delivery(f)), /stopped|revoked/);
    assert.deepEqual((await f.host.storage.get(key)).value, record, 'off-mode preserves historical records');
    assert.equal(f.sent.length, 0);

    f.active = await f.module.start(f.host);
    const read = await rpc(f, 'cat_cafe_dot_read_source', { event_id: record.eventId });
    assert.equal(read.error, undefined, JSON.stringify(read.error));
    assert.equal(read.result.structuredContent.source.id, record.sourceMessageId);
    const reply = await rpc(f, 'cat_cafe_dot_reply', { event_id: record.eventId, content: sample.replyContent });
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    assert.deepEqual(reply.result.structuredContent, { messageId: record.replyMessageId, duplicate: true });
    assert.equal(f.sent.length, 0, 'an already-persisted reply is never sent twice');
    const retained = (await f.host.storage.get(key)).value;
    assert.equal(retained.deliveryId, record.deliveryId, 'old addressed identity is not discarded');
    assert.equal(retained.replyMessageId, record.replyMessageId);

    f.messages.set(f.source.id, { ...f.source, sourceRevision: 'edited-after-history' });
    const stale = await rpc(f, 'cat_cafe_dot_read_source', { event_id: record.eventId });
    assert.ok(stale.error, 'a replayed history record cannot bypass source revision checks');
    assert.equal(f.sent.length, 0);
  });
}
