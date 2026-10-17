import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { FeatureContext, PluginNativeTaskContext, PluginMessage } from '@clowder-ai/plugin-sdk';
import { collectiveSourceIdentitySchema, type CollectiveSourceIdentity } from './business/contracts/index.js';
import { workResultArtifactSnapshotSchema } from './business/connector/state.js';
import type { CollectiveWorkResultPublication } from './business/connector/work-result-publication.js';
import { collectiveContextError } from './collective-context-refs.js';

const ref = z.string().min(1).max(1000);
const revision = z.number().int().positive();
const scopeSchema = z.object({source: collectiveSourceIdentitySchema, workId: ref, pluginInstanceId: ref, ownerUserId: ref, catId: ref, threadId: ref,
  taskRef: ref.regex(/^task:work:/), taskRevision: revision, admissionRef: ref, executionRef: ref,
  sourceRef: ref, refScope: ref, assignmentEventId: ref, resultRevision: revision, executionRevision: revision}).strict();
const inputSchema = z.object({text: z.string().min(1), mediaType: z.enum(['text/markdown', 'text/plain'])}).strict();
const captureBase = z.object({v: z.literal(1), scope: scopeSchema,
  publisher: z.object({invocationId: ref, triggerMessageId: ref}).strict()}).strict();
const textCaptureSchema = captureBase.extend({kind: z.literal('text'),
  text: z.string().min(1), mediaType: z.enum(['text/markdown', 'text/plain']),
  contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  snapshot: workResultArtifactSnapshotSchema.optional()}).strict();
const emptyCaptureSchema = captureBase.extend({kind: z.literal('none')}).strict();
const captureSchema = z.discriminatedUnion('kind', [textCaptureSchema, emptyCaptureSchema]);
type Capture = z.infer<typeof textCaptureSchema>;
export interface CollectiveWorkArtifactBinding {
  readonly auth: PluginNativeTaskContext;
  readonly source: CollectiveSourceIdentity;
  readonly sourceRef: string;
  readonly refScope: string;
  readonly work: {readonly workId: string; readonly revision: number; readonly resultRevision: number;
    readonly executionRevision: number; readonly assignmentEventId: string};
  revalidate(): Promise<void>;
}
const digest = (data: string) => createHash('sha256').update(data).digest('hex');
const changed = () => collectiveContextError('WORK_ARTIFACT_UNAVAILABLE', 'Private Work publication is missing or changed');
const content = 'Collective Work text artifact';
const keyOf = (scope: z.infer<typeof scopeSchema>) => 'collective-work-artifact:' + digest(JSON.stringify(scope));
const artifactRefOf = (scope: z.infer<typeof scopeSchema>) => 'collective-artifact:' + digest(JSON.stringify(scope));
function scopeOf(binding: CollectiveWorkArtifactBinding) {
  const {auth, work} = binding;
  return scopeSchema.parse({source: binding.source, workId: work.workId, pluginInstanceId: auth.source.extra.pluginMessage.instanceId,
    ownerUserId: auth.userId, catId: auth.catId, threadId: auth.threadId,
    taskRef: auth.task.taskRef, taskRevision: auth.task.taskRevision, admissionRef: auth.task.admissionRef,
    executionRef: auth.task.executionRef, sourceRef: binding.sourceRef, refScope: binding.refScope,
    assignmentEventId: work.assignmentEventId, resultRevision: work.resultRevision, executionRevision: work.executionRevision});
}
function bytesOf(text: string) {
  const bytes = Buffer.from(text, 'utf8');
  if (!bytes.length || bytes.length > 65536 || bytes.toString('utf8') !== text || text.includes('\0')) throw changed();
  return bytes;
}
function parsed(raw: unknown) {
  const value = captureSchema.safeParse(raw);if (!value.success) throw changed();
  if (value.data.kind === 'text') {
    bytesOf(value.data.text);
    if (value.data.contentDigest !== 'sha256:' + digest(value.data.text)) throw changed();
  }
  return value.data;
}
function fileOf(capture: Capture) {
  return {type: 'file' as const, url: artifactRefOf(capture.scope),
    fileName: 'cwork-' + digest(JSON.stringify(capture.scope)) + (capture.mediaType === 'text/markdown' ? '.md' : '.txt'),
    mimeType: capture.mediaType, fileSize: bytesOf(capture.text).length};
}
function metaOf(capture: Capture) {
  return {workArtifact: {v: 1, artifactRef: artifactRefOf(capture.scope), taskRef: capture.scope.taskRef,
    executionRef: capture.scope.executionRef, resultRevision: capture.scope.resultRevision,
    executionRevision: capture.scope.executionRevision, contentDigest: capture.contentDigest,
    publisherCatId: capture.scope.catId, invocationId: capture.publisher.invocationId, triggerMessageId: capture.publisher.triggerMessageId}};
}
function assertMessage(capture: Capture, message: PluginMessage | null, messageId: string) {
  if (!message || message.id !== messageId || message.userId !== capture.scope.ownerUserId ||
    message.threadId !== capture.scope.threadId || message.catId !== null || message.content !== content ||
    message.source?.connector !== 'collective' || !isDeepStrictEqual(message.source.meta, metaOf(capture)) ||
    !isDeepStrictEqual(message.contentBlocks, [fileOf(capture)])) throw changed();
  return message;
}

/** Package-owned result aggregate in the existing private CAS. Capture occurs
 * inside a genuine Work native consumer; neither message metadata nor this
 * container grants execution. Ordinary send stays an ordinary plugin message.
 * Bytes remain private; only a file reference is published. Historical Service
 * acceptance is a separate reader and cannot be inferred from this current seal. */
export function createCollectiveWorkArtifacts(context: Pick<FeatureContext, 'storage' | 'messaging' | 'threads'>) {
  async function read(binding: CollectiveWorkArtifactBinding) {
    await binding.revalidate();const scope = scopeOf(binding);
    const entry = await context.storage.get(keyOf(scope));await binding.revalidate();
    if (!entry) return undefined;
    const capture = parsed(entry.value);if (!isDeepStrictEqual(capture.scope, scope)) throw changed();
    return {entry, capture};
  }
  async function verify(binding: CollectiveWorkArtifactBinding, capture: Capture) {
    const snapshot = capture.snapshot, seal = snapshot?.textPublication;
    if (!snapshot || !seal || !context.messaging.get) throw changed();
    const message = assertMessage(capture, await context.messaging.get(seal.sourceMessageId), seal.sourceMessageId);
    await binding.revalidate();
    const thread = await context.threads.get(capture.scope.threadId);await binding.revalidate();
    if (!thread || thread.id !== capture.scope.threadId || snapshot.previewRef !== thread.deepLinkUrl ||
      snapshot.openInWorkspaceRef !== thread.deepLinkUrl || snapshot.artifactRef !== artifactRefOf(capture.scope) || snapshot.taskRef !== capture.scope.taskRef ||
      snapshot.taskRevision !== capture.scope.taskRevision || snapshot.artifactRevision !== message.sourceRevision ||
      snapshot.completenessRef !== `message:${capture.scope.threadId}:${message.id}#available:${message.sourceRevision}` ||
      seal.taskId !== capture.scope.taskRef.slice('task:work:'.length) ||
      seal.resultRevision !== capture.scope.resultRevision || seal.executionRevision !== capture.scope.executionRevision ||
      seal.executionRef !== capture.scope.executionRef || seal.sourceMessageRevision !== message.sourceRevision ||
      seal.publisherCatId !== capture.scope.catId || seal.invocationId !== capture.publisher.invocationId ||
      seal.triggerMessageId !== capture.publisher.triggerMessageId || seal.item.kind !== 'content-block' || seal.item.index !== 0 ||
      seal.contentDigest !== capture.contentDigest || seal.byteLength !== bytesOf(capture.text).length ||
      seal.mediaType !== capture.mediaType) throw changed();
    // Thread/authority reads may await. Recheck the immutable publication after
    // those waits instead of returning the earlier detached message snapshot.
    const latest = assertMessage(capture, await context.messaging.get(seal.sourceMessageId), seal.sourceMessageId);
    if (latest.sourceRevision !== message.sourceRevision) throw changed();
    return snapshot;
  }
  return Object.freeze({
    async publishText(binding: CollectiveWorkArtifactBinding, unsafe: z.infer<typeof inputSchema>) {
      const input = inputSchema.parse(unsafe);bytesOf(input.text);
      await binding.revalidate();const scope = scopeOf(binding), key = keyOf(scope);
      let before = await read(binding);
      if (!before) {
        const capture = textCaptureSchema.parse({v: 1, kind: 'text', scope, publisher: {invocationId: binding.auth.invocationId,
          triggerMessageId: binding.auth.originTriggerMessageId}, ...input, contentDigest: 'sha256:' + digest(input.text)});
        await binding.revalidate();await context.storage.compareAndSet(key, null, capture);
        before = await read(binding);
      }
      if (!before || before.capture.kind !== 'text' || before.capture.text !== input.text || before.capture.mediaType !== input.mediaType) throw changed();
      if (before.capture.snapshot) return verify(binding, before.capture);
      const capture = before.capture;
      if (!context.messaging.get) throw changed();
      const thread = await context.threads.get(scope.threadId);await binding.revalidate();
      if (!thread || thread.id !== scope.threadId) throw changed();
      const receipt = await context.messaging.send(scope.threadId, {idempotencyKey: key, identity: 'collective', meta: metaOf(capture),
        contentBlocks: [fileOf(capture)], payload: {provenance: {origin: {kind: 'plugin', instanceId: scope.pluginInstanceId},
          epistemicStatus: 'observation'}, elements: [{elementId: 'work-text-artifact', kind: 'text', payload: {text: content}}]}});
      if (receipt.threadId !== scope.threadId) throw changed();
      const message = assertMessage(capture, await context.messaging.get(receipt.messageId), receipt.messageId);
      await binding.revalidate();
      const snapshot = workResultArtifactSnapshotSchema.parse({taskRef: scope.taskRef, taskRevision: scope.taskRevision,
        artifactRef: artifactRefOf(scope), artifactRevision: message.sourceRevision,
        completenessRef: `message:${scope.threadId}:${message.id}#available:${message.sourceRevision}`,
        previewRef: thread.deepLinkUrl, openInWorkspaceRef: thread.deepLinkUrl,
        textPublication: {v: 1, taskId: scope.taskRef.slice('task:work:'.length), resultRevision: scope.resultRevision,
          executionRevision: scope.executionRevision, executionRef: scope.executionRef, sourceMessageId: message.id,
          sourceMessageRevision: message.sourceRevision, triggerMessageId: capture.publisher.triggerMessageId,
          publisherCatId: scope.catId, invocationId: capture.publisher.invocationId, item: {kind: 'content-block', index: 0},
          contentDigest: capture.contentDigest, byteLength: bytesOf(capture.text).length, mediaType: capture.mediaType}});
      const latest = await read(binding);if (!latest || !isDeepStrictEqual(latest.capture, capture)) {
        if (!latest || latest.capture.kind !== 'text' || !isDeepStrictEqual(latest.capture.snapshot, snapshot)) throw changed();
      } else {
        await binding.revalidate();await context.storage.compareAndSet(key, latest.entry.revision, {...capture, snapshot});
      }
      const bound = await read(binding);if (!bound || bound.capture.kind !== 'text' || !isDeepStrictEqual(bound.capture.snapshot, snapshot)) throw changed();
      return verify(binding, bound.capture);
    },
    async selectForReturn(binding: CollectiveWorkArtifactBinding, expectedSnapshot?: z.infer<typeof workResultArtifactSnapshotSchema>) {
      let selected = await read(binding);
      if (!selected) {
        if (expectedSnapshot) throw changed();
        const scope = scopeOf(binding);
        const capture = emptyCaptureSchema.parse({v: 1, kind: 'none', scope,
          publisher: {invocationId: binding.auth.invocationId, triggerMessageId: binding.auth.originTriggerMessageId}});
        await binding.revalidate();await context.storage.compareAndSet(keyOf(scope), null, capture);
        selected = await read(binding);if (!selected) throw changed();
      }
      if (selected.capture.kind === 'none') {if (expectedSnapshot) throw changed();return undefined;}
      const snapshot = await verify(binding, selected.capture);
      if (expectedSnapshot && !isDeepStrictEqual(snapshot, expectedSnapshot)) throw changed();
      return {snapshot, text: selected.capture.text};
    },
    async readCurrent(binding: CollectiveWorkArtifactBinding) {
      const value = await read(binding);if (!value || value.capture.kind === 'none') return undefined;
      return {snapshot: await verify(binding, value.capture), text: value.capture.text};
    },
    /** Only the original current Work/accepted-outbox selector may call this.
     * A prior publication is readable evidence, never an old execution grant. */
    async readAccepted(binding: CollectiveWorkArtifactBinding, publication: CollectiveWorkResultPublication,
      beforeReturn?: () => Promise<void>) {
      await binding.revalidate();
      const snapshot = publication.artifactSnapshot, seal = snapshot?.textPublication;
      const match = /^collective-artifact:([a-f0-9]{64})$/.exec(snapshot?.artifactRef ?? '');
      if (!snapshot || !seal || !match || !context.messaging.get ||
        publication.workId !== binding.work.workId || publication.taskRef !== binding.auth.task.taskRef ||
        publication.localOwnerUserId !== binding.auth.userId || publication.catId !== binding.auth.catId ||
        publication.serviceInstanceId !== binding.source.serviceInstanceId || publication.collectiveId !== binding.source.collectiveId ||
        publication.connectionId !== binding.source.connectionId || publication.channelId !== binding.source.location.channelId ||
        publication.authorizedHumanId !== (binding.source.actor.kind === 'human'
          ? binding.source.actor.humanId : binding.source.actor.human.humanId) ||
        publication.assignmentEventId !== binding.work.assignmentEventId ||
        publication.resultRevision >= binding.work.resultRevision || snapshot.taskRef !== publication.taskRef ||
        snapshot.taskRevision !== publication.taskRevision || seal.resultRevision !== publication.resultRevision ||
        seal.executionRevision !== (publication.executionRevision ?? 1) || seal.executionRevision > binding.work.executionRevision)
        throw changed();
      const entry = await context.storage.get('collective-work-artifact:' + match[1]); await binding.revalidate();
      if (!entry) throw changed();
      const capture = parsed(entry.value);
      if (capture.kind !== 'text' || !isDeepStrictEqual(capture.snapshot, snapshot) ||
        artifactRefOf(capture.scope) !== snapshot.artifactRef || capture.scope.workId !== publication.workId ||
        capture.scope.taskRef !== publication.taskRef || capture.scope.taskRevision !== publication.taskRevision ||
        capture.scope.ownerUserId !== binding.auth.userId || capture.scope.catId !== binding.auth.catId ||
        capture.scope.threadId !== binding.auth.threadId ||
        capture.scope.pluginInstanceId !== binding.auth.source.extra.pluginMessage.instanceId ||
        capture.scope.assignmentEventId !== publication.assignmentEventId || capture.scope.resultRevision !== publication.resultRevision ||
        capture.scope.executionRevision !== (publication.executionRevision ?? 1) ||
        capture.scope.source.serviceInstanceId !== publication.serviceInstanceId ||
        capture.scope.source.collectiveId !== publication.collectiveId || capture.scope.source.connectionId !== publication.connectionId ||
        capture.scope.source.catId !== publication.catId || capture.scope.source.location.channelId !== publication.channelId ||
        capture.scope.refScope !== `${capture.scope.sourceRef}:work:${seal.taskId}:${capture.scope.taskRevision}:result:${capture.scope.resultRevision}:execution:${capture.scope.executionRevision}:${capture.scope.executionRef}`)
        throw changed();
      const trigger = await context.messaging.get(capture.publisher.triggerMessageId); await binding.revalidate();
      if (!trigger || trigger.id !== capture.publisher.triggerMessageId || trigger.userId !== capture.scope.ownerUserId ||
        trigger.threadId !== capture.scope.threadId || trigger.catId !== null || trigger.source) throw changed();
      await verify(binding, capture);
      // Recheck the accepted witness outside its connection fence before the
      // final private/material reads. It cannot turn an old message into a lease.
      await beforeReturn?.();
      const latest = await context.storage.get('collective-work-artifact:' + match[1]); await binding.revalidate();
      if (!latest || !isDeepStrictEqual(latest, entry)) throw changed();
      const [latestTrigger, latestPublication] = await Promise.all([
        context.messaging.get(capture.publisher.triggerMessageId), context.messaging.get(seal.sourceMessageId),
      ]);
      if (!isDeepStrictEqual(latestTrigger, trigger) ||
        assertMessage(capture, latestPublication, seal.sourceMessageId).sourceRevision !== seal.sourceMessageRevision) throw changed();
      return {state: 'available' as const, artifactRef: snapshot.artifactRef, artifactRevision: snapshot.artifactRevision,
        sourceMessageRef: `message:${capture.scope.threadId}:${seal.sourceMessageId}`, resultEventId: publication.resultEventId,
        resultRevision: publication.resultRevision, contentDigest: seal.contentDigest, mediaType: seal.mediaType, text: capture.text,
        trust: 'untrusted_external' as const, sourceTrust: 'unknown' as const, instructionPolicy: 'data_only' as const};
    },
  });
}
