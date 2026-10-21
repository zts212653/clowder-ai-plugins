import { threadMappings } from './thread-mappings.js';
import type { PluginMessage, PluginTaskReadItem, PluginTaskHost, PluginThreadHost, PluginStorageHost } from "@clowder-ai/plugin-sdk";
import {createHash} from 'node:crypto';
import {readWorkFirstReceipt, type ManualWorkExecutionBinding} from './owner-work-first-receipt.js';

type Source = Pick<PluginMessage, "id" | "userId" | "threadId" | "content">;
type Work = Pick<PluginTaskReadItem, "id" | "kind" | "status" | "subjectKey" | "userId" | "ownerCatId" | "threadId" | "entrustedWork">;
export type CollectiveWorkTaskSite = Readonly<{
  kind: 'existing'; taskId: string; taskRef: string; threadId: string; subjectKey: string;
  dataControllerReceiptRef?: string;
}> | Readonly<{kind:'ensure'; threadId: string; subjectKey: string}>;

const OFFICIAL_PLUGIN_ID = 'official.collective-connector';
const error = (code: string, message: string, details: object = {}) => Object.assign(new Error(message), {code, ...details});
const admissionAuthority = (pluginInstanceId: string, subjectKey: string) => `plugin-task-data:${createHash('sha256')
  .update(JSON.stringify([pluginInstanceId, subjectKey])).digest('hex')}`;

/** The original Collective source/cat site policy, separated from neutral Host
 * ownership, parent inheritance and canonical thread creation. This detached plan
 * grants nothing; an authenticated caller must consume it through the Host.
 * The caller supplies authenticated source facts; body fields grant nothing. */
export function selectCollectiveWorkThread(tasks: readonly Work[], source: Source, catId: string,
  pluginInstanceId: string, storedBinding?: ManualWorkExecutionBinding) {
  const matches = tasks.filter(
    (task) =>
      task.userId === source.userId &&
      task.ownerCatId === catId &&
      task.entrustedWork?.admission.sourceRefs[0] === `message:${source.id}`,
  );
  if (matches.length > 1)
    throw Object.assign(new Error("Source resolves to multiple existing Works"), { code: "WORK_SOURCE_AMBIGUOUS" });
  if (matches[0]) return assertCollectiveWorkTask(matches[0], source, catId, pluginInstanceId, storedBinding);
  return Object.freeze({
    kind: "ensure" as const,
    key: `collective-work:${source.id}:${catId}`,
    input: Object.freeze({
      title: source.content.slice(0, 160),
      participants: Object.freeze([catId]),
      parentThreadId: source.threadId,
    }),
  });
}

export function assertCollectiveWorkTask(task: Work, source: Source, catId: string, pluginInstanceId: string,
  storedBinding?: ManualWorkExecutionBinding, options: {allowTerminal?:boolean;allowStaleController?:boolean;
    allowControllerReplacement?:boolean} = {}): Extract<CollectiveWorkTaskSite,{kind:'existing'}> {
  const work = task.entrustedWork;
  if (!work || task.kind !== 'work' || (!options.allowTerminal && (task.status === 'done' || work.closure.state !== 'open')) ||
    task.userId !== source.userId || task.ownerCatId !== catId ||
    work.admission.sourceRefs[0] !== `message:${source.id}` || !task.subjectKey || !work.admission.authorityRef)
    throw error('OWNER_TASK_UNAVAILABLE', 'The original owner Task is not an open entrusted Work');
  if (storedBinding && (storedBinding.taskRef !== `task:work:${task.id}` || storedBinding.threadId !== task.threadId ||
    storedBinding.admissionRef !== `message:${source.id}`))
    throw error('OWNER_TASK_LOCATOR_UNAVAILABLE', 'The stored Work locator no longer identifies its original Task');
  const controller = work.dataController;
  if (controller?.state === 'active') {
    const binding = controller.binding;
    const sameSnapshot = binding.userId === source.userId && binding.catId === catId &&
      binding.threadId === task.threadId && binding.subjectKey === task.subjectKey &&
      binding.firstSourceRef === `message:${source.id}` && binding.admissionAuthorityRef === work.admission.authorityRef &&
      binding.pluginId === OFFICIAL_PLUGIN_ID && binding.moduleRef === `plugin:${OFFICIAL_PLUGIN_ID}`;
    if (!sameSnapshot)
      throw error('OWNER_DATA_CONTROLLER_CONFLICT', 'The original Task is controlled by another or changed installation');
    if (binding.pluginInstanceId !== pluginInstanceId && !options.allowStaleController)
      throw error('OWNER_ADOPTION_REQUIRED', 'The original Task belongs to a previous installation and needs owner adoption',
        {adoption:Object.freeze({taskId:task.id,sourceMessageId:source.id,catId})});
    if (storedBinding?.dataControllerReceiptRef !== undefined &&
      storedBinding.dataControllerReceiptRef !== binding.ownerOperationReceiptRef &&
      !options.allowControllerReplacement)
      throw error('OWNER_ADOPTION_REQUIRED', 'The Host controller changed before its Task locator was retained',
        {adoption:Object.freeze({taskId:task.id,sourceMessageId:source.id,catId})});
    if (!controller.currentForCaller && !options.allowStaleController)
      throw error('OWNER_ADOPTION_REQUIRED', 'The original Task controller is no longer current and needs a new owner confirmation',
        {adoption:Object.freeze({taskId:task.id,sourceMessageId:source.id,catId})});
    return Object.freeze({kind:'existing',taskId:task.id,taskRef:`task:work:${task.id}`,threadId:task.threadId,
      subjectKey:task.subjectKey,dataControllerReceiptRef:binding.ownerOperationReceiptRef});
  }
  if (controller?.state === 'revoked')
    throw error('OWNER_ADOPTION_REQUIRED', 'The original Task data controller was revoked and needs a new owner confirmation',
      {adoption:Object.freeze({taskId:task.id,sourceMessageId:source.id,catId})});
  if (work.admission.authorityRef === admissionAuthority(pluginInstanceId, task.subjectKey)) {
    if (storedBinding?.dataControllerReceiptRef)
      throw error('OWNER_TASK_LOCATOR_UNAVAILABLE', 'The stored controller receipt does not match current Task admission');
    return Object.freeze({kind:'existing',taskId:task.id,taskRef:`task:work:${task.id}`,threadId:task.threadId,
      subjectKey:task.subjectKey});
  }
  throw error('OWNER_ADOPTION_REQUIRED', 'The original Task needs explicit owner adoption before this installation can maintain it',
    {adoption:Object.freeze({taskId:task.id,sourceMessageId:source.id,catId})});
}

export async function locateCollectiveWorkTask(
  tasks: Pick<PluginTaskHost,'get'|'list'>,
  storage: Pick<PluginStorageHost,'get'>,
  source: Source,
  catId: string,
  pluginInstanceId: string,
  options: {allowTerminal?:boolean;allowStaleController?:boolean;allowControllerReplacement?:boolean} = {},
): Promise<Readonly<{site: Extract<CollectiveWorkTaskSite,{kind:'existing'}>; task: PluginTaskReadItem}> | undefined> {
  const receipt = await readWorkFirstReceipt(storage, source.userId, source.id, catId);
  const storedBinding = receipt?.binding;
  if (storedBinding) {
    const taskId = storedBinding.taskRef.slice('task:work:'.length);
    const task = await tasks.get({id:taskId});
    if (!task) throw error('OWNER_TASK_LOCATOR_UNAVAILABLE', 'The stored Work locator names a missing Task');
    return Object.freeze({site:assertCollectiveWorkTask(task, source, catId, pluginInstanceId, storedBinding,options),task});
  }
  const rows = await tasks.list({kind:'work'});
  const matches = options.allowTerminal ? rows.filter(task => task.userId === source.userId && task.ownerCatId === catId &&
    task.entrustedWork?.admission.sourceRefs[0] === `message:${source.id}`) : undefined;
  const selected = options.allowTerminal && matches?.length === 1
    ? assertCollectiveWorkTask(matches[0]!,source,catId,pluginInstanceId,undefined,options)
    : selectCollectiveWorkThread(rows, source, catId, pluginInstanceId);
  if (selected.kind === 'ensure') return undefined;
  const task = await tasks.get({id:selected.taskId});
  if (!task) throw error('OWNER_TASK_LOCATOR_UNAVAILABLE', 'The selected Work Task disappeared');
  return Object.freeze({site:assertCollectiveWorkTask(task, source, catId, pluginInstanceId,undefined,options),task});
}

/** Resolve the existing Work or save a plugin-owned mapping after ordinary
 * Host get/create calls. Host validates resources, parent/project inheritance
 * and participants. This function neither admits a Task nor chooses business basis. */
export async function resolveCollectiveWorkThread(
  threads: Pick<PluginThreadHost, "get" | "create">,
  tasks: Pick<PluginTaskHost, "get" | "list">,
  source: Source,
  catId: string,
  pluginInstanceId: string,
  storage: Pick<PluginStorageHost, "get" | "compareAndSet">,
  options: {threadId?: string} = {},
) : Promise<CollectiveWorkTaskSite> {
  const located = await locateCollectiveWorkTask(tasks, storage, source, catId, pluginInstanceId);
  if (located) {
    const site = located.site;
    const owned = await threads.get(site.threadId);
    if (!owned)
      throw Object.assign(new Error("The owned execution Thread is unavailable"), {
        code: "OWNER_ADMISSION_UNAVAILABLE",
      });
    return site;
  }
  const ensure = selectCollectiveWorkThread([], source, catId, pluginInstanceId);
  if (ensure.kind !== 'ensure') throw new Error('Expected an absent Work site');
  if (options.threadId) return Object.freeze({kind:'ensure',threadId:options.threadId,subjectKey:ensure.key});
  const thread = await threadMappings({ threads, storage } as import('@clowder-ai/plugin-sdk').FeatureContext)
    .ensureByKey(ensure.key, ensure.input);
  return Object.freeze({kind:'ensure',threadId:thread.id,subjectKey:ensure.key});
}
