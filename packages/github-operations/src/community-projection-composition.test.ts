import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryStorage } from '../test/memory-storage.js';
import { CommunityProjector, CommunityProjectionOperations } from './business/domains/community/community-projector.js';
import { SdkCommunityEventLog } from './business/domains/community/CommunityEventLog.js';
import { SdkCommunityObjectStore } from './business/domains/community/CommunityObjectStore.js';
import type { CommunityEvent } from './business/model/index.js';

const subject = 'issue:org/repo#1';
const event = (kind: CommunityEvent['kind'], at: number): CommunityEvent => ({
  sourceEventId: `${kind}:${at}`, subjectKey: subject, kind, at, classification: 'state-changing',
  payload: kind === 'case.bootstrap' ? { mappedState: 'fixed' } : {},
});

test('request and collector projectors cannot overwrite each other after reading the same subject', async () => {
  const storage = memoryStorage();
  const events = new SdkCommunityEventLog(storage), objects = new SdkCommunityObjectStore(storage);
  const operations = new CommunityProjectionOperations();
  const background = new CommunityProjector(events, objects, operations);
  await background.apply(event('case.bootstrap', 1));
  let read!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { read = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let intercept = true;
  const request = new CommunityProjector(events, {
    get: async key => { const value = await objects.get(key); if (intercept) { intercept = false; read(); await blocked; } return value; },
    save: value => objects.save(value), delete: key => objects.delete(key), listSubjectKeys: () => objects.listSubjectKeys(),
  }, operations);
  const reporting = request.applyChecked(event('case.reported', 2));
  await entered;
  const closing = background.apply(event('issue.closed', 3));
  await new Promise(resolve => setImmediate(resolve));
  release();
  await Promise.all([reporting, closing]);
  const projection = await objects.get(subject);
  assert.equal(projection?.state, 'closed');
  assert.equal(projection?.lastPublicCommentAt, 2);
});
