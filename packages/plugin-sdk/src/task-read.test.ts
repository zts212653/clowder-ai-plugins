import assert from 'node:assert/strict';
import test from 'node:test';
import {projectTaskDataControllerMutationResult,projectTaskRead} from './task-read.js';

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

test('Task read exposes only the typed current data-controller projection and immutable admission authority', () => {
  const task = {
    id: 'legacy-work',
    kind: 'work',
    userId: 'owner',
    threadId: 'thread',
    subjectKey: 'entrusted:legacy',
    title: 'Legacy Work',
    ownerCatId: 'cat',
    status: 'todo',
    why: 'Continue original Work',
    createdBy: 'owner',
    createdAt: 1,
    updatedAt: 2,
    entrustedWork: {
      revision: 4,
      closure: { state: 'open' },
      admission: { sourceRefs: ['message:first'], authorityRef: 'message:admission' },
      dataController: {
        bindingRevision: 3,
        state: 'active',
        currentForCaller: true,
        binding: {
          userId: 'owner',
          catId: 'cat',
          threadId: 'thread',
          subjectKey: 'entrusted:legacy',
          firstSourceRef: 'message:first',
          admissionAuthorityRef: 'message:admission',
          pluginId: 'official.collective-connector',
          pluginInstanceId: 'pi-current',
          moduleRef: 'plugin:official.collective-connector',
          lifecycleRevision: 8,
          grantRevision: 3,
          ownerOperationReceiptRef: `task-data-controller:${'a'.repeat(64)}`,
        },
        receipts: [{ private: 'not projected' }],
      },
    },
  };
  const read = projectTaskRead(task)!;
  assert.deepEqual(read.entrustedWork?.admission, {
    sourceRefs: ['message:first'],
    authorityRef: 'message:admission',
  });
  assert.deepEqual(read.entrustedWork?.dataController, {
    bindingRevision: 3,
    state: 'active',
    currentForCaller: true,
    binding: task.entrustedWork.dataController.binding,
  });
  assert.equal('receipts' in read.entrustedWork!.dataController!, false);
  assert.equal(Object.isFrozen(read.entrustedWork!.dataController!.binding), true);
  assert.throws(
    () =>
      projectTaskRead({
        ...task,
        entrustedWork: {
          ...task.entrustedWork,
          dataController: { ...task.entrustedWork.dataController, state: 'forged' },
        },
      }),
    /dataController/,
  );
  assert.throws(() => projectTaskRead({...task,threadId:'moved-thread'}),/currentForCaller/);
  assert.throws(() => projectTaskRead({...task,entrustedWork:{...task.entrustedWork,dataController:{
    ...task.entrustedWork.dataController,state:'revoked',currentForCaller:true,
    revocationReceiptRef:`task-data-controller:${'b'.repeat(64)}`}}}),/currentForCaller/);
});

test('Task controller mutation results share the read projection and reject mismatched Host receipts',()=>{
  const bindReceipt=`task-data-controller:${'a'.repeat(64)}`;
  const task={id:'legacy-work',kind:'work',userId:'owner',threadId:'thread',subjectKey:'entrusted:legacy',
    title:'Legacy Work',ownerCatId:'cat',status:'todo',why:'Continue',createdBy:'owner',createdAt:1,updatedAt:2,
    entrustedWork:{revision:4,artifactRefs:[],closure:{state:'open'},admission:{sourceRefs:['message:first'],
      authorityRef:'message:admission'},dataController:{bindingRevision:1,state:'active',currentForCaller:true,binding:{
        userId:'owner',catId:'cat',threadId:'thread',subjectKey:'entrusted:legacy',firstSourceRef:'message:first',
        admissionAuthorityRef:'message:admission',pluginId:'official.collective-connector',pluginInstanceId:'pi-current',
        moduleRef:'plugin:official.collective-connector',lifecycleRevision:8,grantRevision:3,
        ownerOperationReceiptRef:bindReceipt},receipts:[{private:'not projected'}]}}};
  const projected=projectTaskDataControllerMutationResult({disposition:'bound',receiptRef:bindReceipt,
    bindingRevision:1,task,privateHostReceiptHistory:['hidden']});
  assert.equal(projected.task.id,task.id);assert.equal(Object.isFrozen(projected.task),true);
  assert.equal('receipts' in projected.task.entrustedWork!.dataController!,false);
  assert.equal('privateHostReceiptHistory' in projected,false);
  for(const raw of [
    {disposition:'bound',receiptRef:`task-data-controller:${'b'.repeat(64)}`,bindingRevision:1,task},
    {disposition:'bound',receiptRef:bindReceipt,bindingRevision:2,task},
    {disposition:'bound',receiptRef:bindReceipt,bindingRevision:1,task:{...task,entrustedWork:{...task.entrustedWork,
      dataController:{...task.entrustedWork.dataController,currentForCaller:false}}}},
    {disposition:'revoked',receiptRef:bindReceipt,bindingRevision:1,task},
    {disposition:'forged',receiptRef:bindReceipt,bindingRevision:1,task},
  ]) assert.throws(()=>projectTaskDataControllerMutationResult(raw),/data-controller result/);
});
