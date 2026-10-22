import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import type {FeatureContext, PluginMessage, PluginMessagingDelivery} from '@clowder-ai/plugin-sdk';
import type {CollectiveConnector} from './business/connector/connector.js';
import {collectiveSourceIdentitySchema, collectiveWorkAssignmentMatches, collectiveWorkExecutionMatches} from './business/contracts/index.js';
import {collectiveContextError} from './collective-context-refs.js';
import {readCollectiveWorkWake} from './collective-work-wake.js';
import {locateCollectiveWorkTask} from './collective-work-thread.js';

export const WORK_MATERIAL_SUBSCRIPTION = 'collective-work-materials';
export const WORK_MATERIAL_RECEIVER = 'collective.work.material.receive';
const ref = z.string().min(1).max(1000);
const fileSchema = z.object({index: z.number().int().nonnegative(), block: z.record(z.unknown()),
  text: z.string().optional(), contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  unavailable: z.boolean().optional()}).strict().refine(file => (file.text === undefined) === (file.contentDigest === undefined),
  'Stored publication text and digest must remain paired');
const captureSchema = z.object({v: z.literal(1), taskRef: ref, message: z.unknown(), trigger: z.unknown(),
  workId: ref, resultRevision: z.number().int().positive(), executionRevision: z.number().int().positive(),
  triggerMessageId: ref, invocationId: ref, files: z.array(fileSchema)}).strict();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const changed = () => collectiveContextError('WORK_ARTIFACT_UNAVAILABLE', 'Original Work publication is missing or changed');
const keyOf = (messageId: string) => 'collective-work-publication:' + digest(messageId);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Capture callback file bytes during the existing Host HMR grant. Receipt is
 * data only: arrival neither selects a result nor grants Work permission. */
export function createCollectiveMessageWorkMaterials(connector: CollectiveConnector,
  context: Pick<FeatureContext, 'pluginInstanceId' | 'messaging' | 'streams' | 'storage' | 'tasks'>, assertActive: () => void) {
  const subscriptions = new Map<string, Promise<void>>();
  const subscribe = async (threadId: string) => {
    assertActive();let pending = subscriptions.get(threadId);
    if (!pending) {
      pending = context.messaging.subscribe(threadId, {contributionId: WORK_MATERIAL_SUBSCRIPTION}).catch(error => {
        subscriptions.delete(threadId);throw error;
      });
      subscriptions.set(threadId, pending);
    }
    await pending;assertActive();
  };
  const get = async (messageId: string) => {
    assertActive();const message = await context.messaging.get(messageId);assertActive();return message;
  };
  return {
    subscribe,
    async restore() {
      for (const task of await context.tasks.list({ kind: 'work' })) {
        assertActive();const work=task.entrustedWork,controller=work?.dataController,binding=controller?.binding;
        // Subscription is a read-only compatibility listener for pre-rich Work
        // projections. Every received material still resolves and fences the
        // exact canonical Task before retaining bytes.
        const legacySubject=task.subjectKey?.startsWith('collective-work:')===true;
        const controllerCurrent=controller?.state==='active'&&controller.currentForCaller&&
          binding?.pluginId==='official.collective-connector'&&binding.moduleRef==='plugin:official.collective-connector'&&
          binding.pluginInstanceId===context.pluginInstanceId&&binding.userId===task.userId&&
          binding.catId===task.ownerCatId&&binding.threadId===task.threadId&&binding.subjectKey===task.subjectKey&&
          binding.firstSourceRef===work?.admission.sourceRefs[0]&&
          binding.admissionAuthorityRef===work?.admission.authorityRef;
        if(legacySubject||controllerCurrent)await subscribe(task.threadId);
      }
    },
    async receive(unsafe: unknown) {
      assertActive();
      if (!object(unsafe) || typeof unsafe.threadId !== 'string' || !object(unsafe.envelope) ||
        unsafe.envelope.threadId !== unsafe.threadId || typeof unsafe.envelope.messageId !== 'string') throw changed();
      const delivery = unsafe as unknown as PluginMessagingDelivery;
      const message = await get(delivery.envelope.messageId);
      if (!message || message.threadId !== delivery.threadId || message.origin !== 'callback' || !message.catId ||
        message.source || message.deliveryStatus === 'queued' || message.deliveryStatus === 'canceled') return;
      const blocks = message.extra?.rich?.blocks ?? [];
      const files = blocks.flatMap((block, index) => object(block) && block.kind === 'file' &&
        typeof block.url === 'string' && /^\/uploads\/[A-Za-z0-9._-]+$/.test(block.url) ? [{index, block}] : []);
      if (!files.length) return;
      const triggerMessageId = message.extra?.causal?.triggerMessageId;
      const invocationId = message.extra?.stream?.turnInvocationId;
      if (!triggerMessageId || !invocationId) return;
      const trigger = await get(triggerMessageId);
      const parsed = collectiveSourceIdentitySchema.safeParse(trigger?.source?.meta?.participation);
      if (!trigger || trigger.userId !== message.userId || trigger.threadId !== message.threadId ||
        trigger.catId !== null || trigger.source?.connector !== 'collective' || !parsed.success || parsed.data.catId !== message.catId) return;
      let source = parsed.data;
      const meta = trigger.source.meta;
      const wake = meta?.workRequest === 'resume' ? await readCollectiveWorkWake(connector, context,
        source.connectionId, source.eventId, message.userId, async () => {assertActive();}) : undefined;
      if (wake) source = wake.source;
      const notice = wake ? wake.item.event.workExecutionNotice ?? wake.item.event.workAcceptanceNotice
        : meta?.workExecutionNotice ?? meta?.workAcceptanceNotice;
      const work = wake?.work ?? (source.actor.kind === 'human'
        ? await connector.readAssignedWorkByAssignment(source.connectionId, source.eventId)
        : object(notice) && typeof notice.workId === 'string' ? await connector.readAssignedWork(source.connectionId, notice.workId) : undefined);
      if (!work || (work.executionAuthority?.eventId ?? work.assignmentEventId) !== source.eventId) return;
      const route = await connector.getHostRoute(source.connectionId);assertActive();
      const connection = await connector.getProjection(source.connectionId);assertActive();
      if (route?.localOwnerUserId !== message.userId || connection.authorityStatus !== 'connected' ||
          connection.authorizedHumanId !== work.accountableHumanId ||
          ((wake?.item.event.workRequest ?? meta?.workRequest) === 'continue'
            ? !collectiveWorkExecutionMatches(source, work, notice)
            : !collectiveWorkAssignmentMatches(source, work, notice))) throw changed();
      let taskSource = trigger;
      if (wake) taskSource = wake.first;
      else if (work.assignmentEventId !== source.eventId) {
        const rows = (await connector.listInbox(source.connectionId)).filter(row => row.event.eventId === work.assignmentEventId);
        const first = rows[0];
        if (rows.length !== 1 || first?.routeReceipt?.kind !== 'thread_message') throw changed();
        const message = await get(first.routeReceipt.messageId);if (!message) throw changed();taskSource = message;
      }
      const task = wake?.task ?? (await locateCollectiveWorkTask(context.tasks, context.storage, taskSource,
        source.catId, context.pluginInstanceId))?.task;assertActive();
      if (!task || task.threadId !== message.threadId || task.ownerCatId !== message.catId ||
        (task.userId !== null && task.userId !== message.userId)) return;
      const existing = await context.storage.get(keyOf(message.id));assertActive();
      if (existing) {
        if (!isDeepStrictEqual(captureSchema.parse(existing.value).message, message)) throw changed();
        return;
      }
      const capturedFiles: z.infer<typeof fileSchema>[] = [];
      for (const file of files) {
        const element = delivery.envelope.payload.elements.find(item => item.elementId === `el_${message.id}_${file.index + 1}`);
        const contentType = file.block.mimeType;
        if (contentType !== 'text/markdown' && contentType !== 'text/plain') {
          capturedFiles.push(file);continue; // Original non-text uploads stay metadata-only.
        }
        if (!element || element.kind !== 'media_ref' || element.payload.type !== 'file' || !element.payload.reference.startsWith('hmr_')) {
          capturedFiles.push({...file, unavailable: true});continue;
        }
        const chunks: Uint8Array[] = [];let size = 0;
        for await (const chunk of context.streams.read(element.payload.reference)) {
          assertActive();size += chunk.byteLength;if (size > 65536) break;chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks), text = bytes.toString('utf8');
        capturedFiles.push(size > 65536 || !size || text.includes('\0') || !Buffer.from(text).equals(bytes)
          ? {...file, unavailable: true} : {...file, text, contentDigest: 'sha256:' + digest(text)});
      }
      if (!isDeepStrictEqual(await get(message.id), message) || !isDeepStrictEqual(await get(trigger.id), trigger)) throw changed();
      const latestWork = await connector.readAssignedWork(source.connectionId, work.workId);assertActive();
      const latestRoute = await connector.getHostRoute(source.connectionId);assertActive();
      const latestTask = (await locateCollectiveWorkTask(context.tasks, context.storage, taskSource,
        source.catId, context.pluginInstanceId))?.task;assertActive();
      if (!isDeepStrictEqual(latestWork, work) || latestRoute?.localOwnerUserId !== message.userId ||
          latestRoute.revision !== route.revision || !latestTask || latestTask.threadId !== task.threadId ||
          latestTask.ownerCatId !== task.ownerCatId || latestTask.userId !== task.userId) throw changed();
      const resultRevision = work.executionAuthority?.resultRevision ?? (work.lifecycle === 'result_ready'
        ? work.resultRevision ?? 1 : work.resultEventId ? (work.resultRevision ?? 1) + 1 : 1);
      const value = captureSchema.parse({v: 1, taskRef: `task:work:${task.id}`, message, trigger, workId: work.workId,
        resultRevision, executionRevision: work.executionAuthority?.revision ?? 1, triggerMessageId, invocationId, files: capturedFiles});
      await context.storage.compareAndSet(keyOf(message.id), null, value);assertActive();
      const stored = await context.storage.get(keyOf(message.id));assertActive();
      if (!stored || !isDeepStrictEqual(stored.value, value)) throw changed();
    },
    async read(messageId: string, artifactRef?: string) {
      const stored = await context.storage.get(keyOf(messageId));assertActive();if (!stored) return undefined;
      const captured = captureSchema.parse(stored.value);
      if (artifactRef && !captured.files.some(file => file.block.url === artifactRef)) return undefined;
      const message = await get(messageId);
      if (!message || !isDeepStrictEqual(captured.message, message) ||
        !isDeepStrictEqual(await get(captured.triggerMessageId), captured.trigger)) throw changed();
      for (const file of captured.files) if (file.text !== undefined && file.contentDigest !== 'sha256:' + digest(file.text)) throw changed();
      return {...captured, message: message as PluginMessage};
    },
    dispose() {
      // The Host subscription session owns runtime teardown and is already stopped before
      // feature disposal. Forget only this activation's replay intents; retained clients must
      // keep rejecting after the Host revokes the session.
      subscriptions.clear();
    },
  };
}
