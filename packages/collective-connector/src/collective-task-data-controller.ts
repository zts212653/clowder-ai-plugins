import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import type {FeatureContext, PluginMessage, PluginOwnerOperationContext, PluginTaskReadItem} from '@clowder-ai/plugin-sdk';
import {operationRowAction} from '@clowder-ai/plugin-sdk';
import {readWorkFirstReceipt, retainWorkFirstReceipt, type ManualWorkExecutionBinding,
  workReceiptDigest} from './owner-work-first-receipt.js';
import {assertCollectiveWorkTask} from './collective-work-thread.js';
import {collectiveSourceIdentitySchema} from './business/contracts/index.js';

export const collectiveTaskControllerInput = z.object({
  taskId:z.string().min(1).max(1000),sourceMessageId:z.string().min(1).max(1000),catId:z.string().min(1).max(240),
}).strict();
export type CollectiveTaskControllerInput = z.infer<typeof collectiveTaskControllerInput>;
type Ports = Pick<FeatureContext,'pluginInstanceId'|'tasks'|'messaging'|'storage'>;
function refuse(code:string,message:string):never {throw Object.assign(new Error(message),{code});}
const operationId = (kind:'bind'|'revoke', taskId:string, revision:number, sourceMessageId:string, catId:string) =>
  `collective-task-controller:${kind}:${createHash('sha256').update(JSON.stringify([taskId,revision,sourceMessageId,catId])).digest('hex')}`;
type EntrustedWork = NonNullable<PluginTaskReadItem['entrustedWork']>;
type EntrustedTask = PluginTaskReadItem & {subjectKey:string;ownerCatId:string;
  entrustedWork:EntrustedWork&{admission:EntrustedWork['admission']&{authorityRef:string}}};
function requiredSource(source:PluginMessage|null):PluginMessage {
  if (!source) return refuse('OWNER_ADOPTION_UNAVAILABLE','The exact original Task source is unavailable');
  return source;
}
function requiredTask(task:PluginTaskReadItem|null):EntrustedTask {
  if (!task?.entrustedWork || !task.subjectKey || !task.ownerCatId || !task.entrustedWork.admission.authorityRef)
    return refuse('OWNER_ADOPTION_UNAVAILABLE','The exact original Task is unavailable');
  return task as EntrustedTask;
}

export async function listCollectiveTaskDataControllerRows(
  ports:Pick<Ports,'pluginInstanceId'|'tasks'|'storage'>,ownerUserId:string,current:()=>Promise<void>,
) {
  const rows=[];
  for(const task of await ports.tasks.list({kind:'work'})){
    await current();
    const work=task.entrustedWork,sourceRef=work?.admission.sourceRefs[0];
    if(!work||task.userId!==ownerUserId||!task.ownerCatId||!sourceRef?.startsWith('message:')||
      work.admission.authorityRef?.startsWith('plugin-task-data:'))continue;
    const sourceMessageId=sourceRef.slice('message:'.length);
    let receipt:Awaited<ReturnType<typeof readWorkFirstReceipt>>;
    try{receipt=await readWorkFirstReceipt(ports.storage,ownerUserId,sourceMessageId,task.ownerCatId);}
    catch{rows.push({key:`task-controller:${task.id}`,label:task.title,
      detail:'The original Work receipt is unavailable; this Task was not changed.'});continue;}
    if(!receipt)continue;
    const controller=work.dataController;
    const family=controller?.binding.pluginId==='official.collective-connector'&&
      controller.binding.moduleRef==='plugin:official.collective-connector';
    const local=family&&controller.binding.pluginInstanceId===ports.pluginInstanceId;
    const locatorCurrent=receipt.binding?.dataControllerReceiptRef!==undefined&&
      receipt.binding.dataControllerReceiptRef===controller?.binding.ownerOperationReceiptRef;
    const locatorNamesTask=!receipt.binding||(receipt.binding.taskRef===`task:work:${task.id}`&&
      receipt.binding.threadId===task.threadId&&receipt.binding.admissionRef===sourceRef);
    const canRevoke=locatorNamesTask&&local&&controller?.state==='active'&&controller.currentForCaller&&locatorCurrent;
    const needsAdopt=locatorNamesTask&&(!controller||(family&&(!local||controller.state==='revoked'||
      !controller.currentForCaller||(controller.state==='active'&&!locatorCurrent))));
    const action=canRevoke?'revoke-task':needsAdopt?'adopt-task':undefined;
    rows.push({key:`task-controller:${task.id}`,label:task.title,
      detail:!locatorNamesTask?'The stored Work locator identifies another Task; no action was taken.'
        :action==='revoke-task'?'This installation currently maintains the original Task.'
        :action==='adopt-task'?'The original Task needs explicit owner adoption before maintenance can continue.'
          :'Another controller owns this original Task; no action was taken.',
      ...(action?{actions:[operationRowAction(action,{taskId:task.id,sourceMessageId,catId:task.ownerCatId})]}:{})});
  }
  await current();return rows;
}

async function sourceAndTask(ports:Ports, ownerUserId:string, input:CollectiveTaskControllerInput,
  current:()=>Promise<void>) {
  await current();const source = requiredSource(await ports.messaging.get(input.sourceMessageId));await current();
  const task = requiredTask(await ports.tasks.get({id:input.taskId}));await current();
  if (source.userId !== ownerUserId || task.userId !== ownerUserId ||
    task.ownerCatId !== input.catId || task.entrustedWork.admission.sourceRefs[0] !== `message:${source.id}` ||
    task.status === 'done' || task.entrustedWork.closure.state !== 'open')
    refuse('OWNER_ADOPTION_UNAVAILABLE','The exact original Task and source are unavailable');
  const receipt = await readWorkFirstReceipt(ports.storage,ownerUserId,source.id,input.catId);await current();
  if (!receipt) return refuse('OWNER_ADOPTION_RECEIPT_UNAVAILABLE','The original Work receipt is unavailable');
  const identity=collectiveSourceIdentitySchema.safeParse(source.source?.meta?.participation);
  if (!identity.success || source.threadId!==receipt.source.threadId || source.sourceRevision!==receipt.source.revision ||
    workReceiptDigest(source.content)!==receipt.source.bodyDigest || !isDeepStrictEqual(identity.data,receipt.source.identity))
    return refuse('OWNER_ADOPTION_RECEIPT_UNAVAILABLE','The original Work receipt no longer matches its source');
  const {binding:_binding,...selected} = receipt;
  const retention = await retainWorkFirstReceipt(ports.storage,selected,current,true);
  return {source,task,receipt,retention};
}

function assertMatchingActive(task:PluginTaskReadItem, source: PluginMessage,
  input:CollectiveTaskControllerInput, pluginInstanceId:string, binding?:ManualWorkExecutionBinding) {
  return assertCollectiveWorkTask(task,source,input.catId,pluginInstanceId,binding);
}

export async function adoptCollectiveTaskDataController(ports:Ports, owner:PluginOwnerOperationContext,
  unsafe:unknown,current:()=>Promise<void>) {
  const input = collectiveTaskControllerInput.parse(unsafe);
  const {source,task,receipt,retention} = await sourceAndTask(ports,owner.userId,input,current);
  const work = task.entrustedWork;
  const activeController=work.dataController?.state==='active'?work.dataController:undefined;
  const locatorNamesCurrent=receipt.binding?.dataControllerReceiptRef!==undefined &&
    receipt.binding.dataControllerReceiptRef===activeController?.binding.ownerOperationReceiptRef;
  if (locatorNamesCurrent && activeController?.currentForCaller === true) {
    assertMatchingActive(task,source,input,ports.pluginInstanceId,receipt.binding);
    return {disposition:'replayed' as const,receiptRef:activeController.binding.ownerOperationReceiptRef,
      bindingRevision:activeController.bindingRevision,
      task,locator:receipt.binding};
  }
  const controller = work.dataController;
  if (controller?.state === 'active') assertCollectiveWorkTask(task,source,input.catId,ports.pluginInstanceId,
    receipt.binding,{allowStaleController:true,allowControllerReplacement:true});
  else {
    try {assertCollectiveWorkTask(task,source,input.catId,ports.pluginInstanceId,receipt.binding);}
    catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'OWNER_ADOPTION_REQUIRED') throw error;
    }
  }
  const replayingPartial = controller?.state === 'active' && controller.currentForCaller === true;
  const nextBindingRevision = replayingPartial ? controller.bindingRevision : (controller?.bindingRevision ?? 0)+1;
  const expectedTaskRevision = replayingPartial ? work.revision-1 : work.revision;
  if (expectedTaskRevision < 1) refuse('OWNER_ADOPTION_UNAVAILABLE','The Task controller revision is invalid');
  const result = await ports.tasks.bindDataController({taskId:task.id,expectedTaskRevision,
    operationId:operationId('bind',task.id,nextBindingRevision,source.id,input.catId),expected:{
      ownerCatId:input.catId,threadId:task.threadId,subjectKey:task.subjectKey,firstSourceRef:`message:${source.id}`,
      admissionAuthorityRef:work.admission.authorityRef,
    }});await current();
  const resultWork=result.task.entrustedWork;
  if (result.task.id !== task.id)
    refuse('OWNER_ADOPTION_UNAVAILABLE','The Host did not return the exact adopted Task');
  if (!resultWork)
    refuse('OWNER_ADOPTION_UNAVAILABLE','The Host did not return the exact adopted Task');
  const resultController=resultWork.dataController;
  if (resultController?.state !== 'active' ||
    resultController.binding.ownerOperationReceiptRef !== result.receiptRef)
    refuse('OWNER_ADOPTION_UNAVAILABLE','The Host did not return the exact adopted Task');
  const locator:ManualWorkExecutionBinding = receipt.binding
    ? {...receipt.binding,taskRevision:resultWork.revision,dataControllerReceiptRef:result.receiptRef}
    : {taskRef:`task:work:${task.id}`,taskRevision:resultWork.revision,threadId:task.threadId,
      admissionRef:`message:${source.id}`,executionRef:`message:${source.id}`,
      refScope:`task-data-controller:${task.id}:${nextBindingRevision}`,dataControllerReceiptRef:result.receiptRef};
  await retention.bind(locator);await current();
  const stored = await readWorkFirstReceipt(ports.storage,owner.userId,source.id,input.catId);await current();
  if (!stored?.binding || !isDeepStrictEqual(stored.binding,locator))
    refuse('OWNER_ADOPTION_UNAVAILABLE','The adopted Task locator was not retained');
  return {...result,locator};
}

export async function revokeCollectiveTaskDataController(ports:Ports, owner:PluginOwnerOperationContext,
  unsafe:unknown,current:()=>Promise<void>) {
  const input = collectiveTaskControllerInput.parse(unsafe);
  const {source,task,receipt} = await sourceAndTask(ports,owner.userId,input,current);
  const locator = receipt.binding;
  const controllerReceiptRef = locator?.dataControllerReceiptRef;
  if (!locator || typeof controllerReceiptRef !== 'string')
    return refuse('OWNER_ADOPTION_UNAVAILABLE','The original Work has no adopted Task controller');
  const exactLocator = locator;
  const work=task.entrustedWork,durable=work.dataController;
  if(durable?.state==='revoked'){
    try {assertCollectiveWorkTask(task,source,input.catId,ports.pluginInstanceId,exactLocator,
      {allowStaleController:true,allowControllerReplacement:true});}
    catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'OWNER_ADOPTION_REQUIRED') throw error;
    }
    const binding=durable.binding;
    if(!durable.revocationReceiptRef||binding.userId!==owner.userId||binding.catId!==input.catId||
      binding.threadId!==task.threadId||binding.subjectKey!==task.subjectKey||binding.firstSourceRef!==`message:${source.id}`||
      binding.admissionAuthorityRef!==work.admission.authorityRef||
      binding.pluginId!=='official.collective-connector'||binding.pluginInstanceId!==ports.pluginInstanceId||
      binding.moduleRef!=='plugin:official.collective-connector'||binding.ownerOperationReceiptRef!==controllerReceiptRef)
      return refuse('OWNER_ADOPTION_UNAVAILABLE','The revoked Task controller no longer matches its locator');
    return{disposition:'replayed' as const,receiptRef:durable.revocationReceiptRef,
      bindingRevision:durable.bindingRevision,task,locator:exactLocator};
  }
  assertMatchingActive(task,source,input,ports.pluginInstanceId,exactLocator);
  if(!durable||durable.state!=='active')return refuse('OWNER_ADOPTION_UNAVAILABLE','The Task controller is unavailable');
  const result = await ports.tasks.revokeDataController({taskId:task.id,expectedTaskRevision:work.revision,
    expectedBindingRevision:durable.bindingRevision,expectedControllerReceiptRef:controllerReceiptRef,
    operationId:operationId('revoke',task.id,durable.bindingRevision+1,source.id,input.catId)});await current();
  if (result.task.id !== task.id || result.task.entrustedWork?.dataController?.state !== 'revoked')
    refuse('OWNER_ADOPTION_UNAVAILABLE','The Host did not return the exact revoked Task');
  return {...result,locator:exactLocator};
}
