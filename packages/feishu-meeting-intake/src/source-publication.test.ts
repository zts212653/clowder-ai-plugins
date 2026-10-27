import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { PluginOwnerOperationContext } from '@clowder-ai/plugin-sdk';
import { createMeetingRecordDelivery } from './record-delivery.js';
import { createMeetingSourcePublication } from './source-publication.js';

test('meeting source publication keeps the private thread private and rechecks current text after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'meeting-publication-'));
  try {
    const owner: PluginOwnerOperationContext = {
      kind: 'owner-operation',
      userId: 'owner',
      pluginInstanceId: 'meeting-instance',
      operationKey: 'sourceMaterial',
      actionId: 'invoke',
      requestId: 'publish',
      signal: new AbortController().signal,
      async assertCurrent() {},
    };
    const records = createMeetingRecordDelivery(join(root, 'records'), { pluginInstanceId: owner.pluginInstanceId });
    const record = await records.record(
      {
        kind: 'minute',
        artifactId: 'minute-1',
        revision: '2026-10-26T21:00:00.000Z',
        generatedAt: '2026-10-26T21:00:00.000Z',
        title: 'Private source title',
      },
      'private-thread',
      owner,
    );
    let text = 'First source passage\nSecond source passage',
      available = true;
    const deps = {
      directory: join(root, 'publications'),
      getRecord: records.get,
      readSource: async () => {
        if (!available) throw new Error('provider access revoked');
        return {
          text,
          textSha256: createHash('sha256').update(text).digest('hex'),
          readAt: new Date().toISOString(),
          generationRevision: record.descriptor.revision,
        };
      },
    };
    const publication = {
      publicationId: 'pub-1',
      serviceInstanceId: 'svc-test',
      collectiveId: 'col-test',
      connectionId: 'con-test',
      humanId: 'human-owner',
      roadmapId: 'roadmap-test',
      channelId: 'general',
      sourceEventId: 'evt_test',
      provider: 'feishu',
      sourceId: record.id,
    };
    const invoke = createMeetingSourcePublication(deps);
    assert.deepEqual(await invoke({ action: 'read', publication }, owner), {
      status: 'unavailable',
      reason: 'not_published',
    });
    const first = await invoke({ action: 'publish', publication }, owner);
    assert.equal(first.status, 'available');
    if (first.status !== 'available') throw new Error('fixture');
    assert.equal(first.material.clauses.length, 2);
    assert.equal(JSON.stringify(first).includes('private-thread'), false);
    text = 'Revised source passage';
    const recovered = await createMeetingSourcePublication(deps)({ action: 'read', publication }, owner);
    assert.equal(recovered.status, 'available');
    if (recovered.status !== 'available') throw new Error('fixture');
    assert.notEqual(recovered.witness.digest, first.witness.digest);
    assert.equal('providerRevision' in recovered.witness, false);
    const files = await readdir(deps.directory);
    const retained = (await Promise.all(files.map((name) => readFile(join(deps.directory, name), 'utf8')))).join('');
    assert.equal(retained.includes('Private source title'), false);
    assert.equal(retained.includes('First source passage'), false);
    available = false;
    const revoked = await invoke({ action: 'read', publication }, owner);
    assert.equal(revoked.status, 'unavailable');
    assert.equal(JSON.stringify(revoked).includes('Private'), false);
    await assert.rejects(
      invoke({ action: 'read', publication: { ...publication, channelId: 'another' } }, owner),
      /scope/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
