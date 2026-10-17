import assert from 'node:assert/strict';
import test from 'node:test';
import {projectTaskRead} from './task-read.js';

test('Task read preserves original canonical time without exposing private execution fields', () => {
  const task = {id: 'work', kind: 'work', userId: 'owner', threadId: 'thread', subjectKey: 'subject',
    title: 'Report', ownerCatId: 'cat', status: 'todo', why: 'Report', createdBy: 'owner', createdAt: 1, updatedAt: 2,
    entrustedWork: {revision: 3, artifactRefs: ['/uploads/report.md'], closure: {state: 'open'}, admission: {sourceRefs: ['message:source']},
      time: {businessDeadline: {value: 1900000000000, sourceRef: 'message:source'}}, executionAuthorityRevision: 1}};
  const read = projectTaskRead(task)!;
  assert.deepEqual(read.entrustedWork!.time, task.entrustedWork.time);
  assert.deepEqual(read.entrustedWork!.artifactRefs, task.entrustedWork.artifactRefs);
  assert.equal(Object.isFrozen(read.entrustedWork!.time!.businessDeadline), true);
  assert.equal('executionAuthorityRevision' in read.entrustedWork!, false);
  assert.throws(() => projectTaskRead({...task, entrustedWork: {...task.entrustedWork,
    time: {businessDeadline: {value: 'tomorrow', sourceRef: 'message:source'}}}}), /time/);
});
