import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CommunityProjector } from '../src/business/domains/community/community-projector.js';

class MemoryEventLog {
  events = [];

  async append(event) {
    this.events.push(structuredClone(event));
    return { appended: true, sequence: this.events.length - 1 };
  }

  async read(subjectKey) {
    return this.events.filter((event) => event.subjectKey === subjectKey).map((event) => structuredClone(event));
  }

  async listSubjects() {
    return [...new Set(this.events.map((event) => event.subjectKey))];
  }
}

class BarrierObjectStore {
  values = new Map();
  blockNextSave = false;
  saveEntered = Promise.resolve();
  releaseSave = () => {};

  armSaveBarrier() {
    this.blockNextSave = true;
    this.saveEntered = new Promise((resolve) => {
      this.signalSaveEntered = resolve;
    });
    this.saveRelease = new Promise((resolve) => {
      this.releaseSave = resolve;
    });
  }

  async get(subjectKey) {
    const value = this.values.get(subjectKey);
    return value ? structuredClone(value) : null;
  }

  async save(projection) {
    if (this.blockNextSave) {
      this.blockNextSave = false;
      this.signalSaveEntered();
      await this.saveRelease;
    }
    this.values.set(projection.subjectKey, structuredClone(projection));
  }

  async listSubjectKeys() {
    return [...this.values.keys()];
  }

  async delete(subjectKey) {
    this.values.delete(subjectKey);
  }
}

const subjectKey = 'issue:owner/repo#42';

describe('CommunityProjector subject admission', () => {
  it('does not let a recovery rebuild overwrite a concurrent collector apply', async () => {
    const eventLog = new MemoryEventLog();
    const objectStore = new BarrierObjectStore();
    const projector = new CommunityProjector(eventLog, objectStore);
    const opened = {
      sourceEventId: 'opened-1',
      subjectKey,
      kind: 'issue.opened',
      classification: 'state-changing',
      payload: {},
      at: 1,
    };
    const commented = {
      sourceEventId: 'comment-2',
      subjectKey,
      kind: 'issue.commented',
      classification: 'informational',
      payload: { body: 'new durable fact' },
      at: 2,
    };

    await eventLog.append(opened);
    await projector.apply(opened);

    objectStore.armSaveBarrier();
    const rebuild = projector.rebuild(subjectKey);
    await objectStore.saveEntered;

    await eventLog.append(commented);
    const apply = projector.apply(commented);
    await new Promise((resolve) => setImmediate(resolve));

    objectStore.releaseSave();
    await Promise.all([rebuild, apply]);

    assert.equal((await eventLog.read(subjectKey)).length, 2);
    assert.deepEqual(await objectStore.get(subjectKey), {
      repo: 'owner/repo',
      type: 'issue',
      number: 42,
      subjectKey,
      state: 'new',
      ownerThreadId: null,
      ownerRole: null,
      nextOwner: 'none',
      lastExternalActivityAt: 2,
      lastPublicCommentAt: null,
      linkedIssues: [],
      linkedPrs: [],
      closureWaiver: null,
      issueFixEvidence: null,
      externalReview: null,
      appliedEventCount: 1,
      lastRejectedEvent: null,
      deliveryCursor: null,
      createdAt: 1,
      updatedAt: 2,
    });
  });
});

for (const terminal of ['closed', 'declined']) it(`report decision waits for queued ${terminal} and remains rejected on replay`, async () => {
  const eventLog = new MemoryEventLog();
  const objects = new BarrierObjectStore();
  const projector = new CommunityProjector(eventLog, objects);
  const event = (kind, at, payload = {}) => ({ sourceEventId: `${kind}:${at}`, subjectKey, kind, classification: 'state-changing', payload, at });
  const fixed = event('case.bootstrap', 1, { mappedState: 'fixed' });
  const closing = event(terminal === 'closed' ? 'case.bootstrap' : 'case.declined', 2, { mappedState: terminal });
  const report = event('case.reported', 3, { actor: 'owner', publicCommentUrl: 'https://github.com/owner/repo/issues/42#issuecomment-1' });
  await eventLog.append(fixed); await projector.apply(fixed);
  await eventLog.append(closing);
  objects.armSaveBarrier();
  const pending = projector.apply(closing);
  await objects.saveEntered;
  await eventLog.append(report);
  const reporting = projector.applyChecked(report);
  objects.releaseSave();
  await pending;
  assert.equal(await reporting, false);
  assert.equal((await objects.get(subjectKey)).state, terminal);
  assert.equal((await objects.get(subjectKey)).lastPublicCommentAt, null);
  await projector.rebuild(subjectKey);
  assert.equal((await objects.get(subjectKey)).state, terminal);
  assert.equal((await objects.get(subjectKey)).lastPublicCommentAt, null);
  assert.equal((await objects.get(subjectKey)).lastRejectedEvent.sourceEventId, report.sourceEventId);
});
