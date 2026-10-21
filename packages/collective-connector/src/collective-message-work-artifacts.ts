import {isDeepStrictEqual} from 'node:util';
import type {FeatureContext} from '@clowder-ai/plugin-sdk';
import type {AssignedWorkAuthorityScope, CollectiveConnector} from './business/connector/connector.js';
import type {CollectiveWorkResultPublication} from './business/connector/work-result-publication.js';
import {workResultArtifactSnapshotSchema} from './business/connector/state.js';
import {collectiveContextError} from './collective-context-refs.js';
import type {createCollectiveMessageWorkCaller} from './collective-message-work.js';
import type {createCollectiveMessageWorkMaterials} from './collective-message-work-materials.js';
import {collectiveWorkArtifactRefsSchema} from './work-native-methods.js';
import { collectiveWorkResultTextSourceSchema } from './business/contracts/index.js';
import { collectiveDocumentFileName, isCollectiveDocumentFile } from './collective-document-scope.js';
import {locateCollectiveWorkTask} from './collective-work-thread.js';

type Binding = Parameters<Parameters<ReturnType<typeof createCollectiveMessageWorkCaller>['withCurrentMessage']>[1]>[0];
const changed = () => collectiveContextError('WORK_ARTIFACT_UNAVAILABLE', 'Explicitly selected Work material is unavailable or changed');
const taskRefOf = (binding: {resultKey:string}) => `task:${binding.resultKey}`;

/** Original explicit selection belongs to the same canonical Task as Schedule.
 * Private captured publication bytes are data, never another selection owner. */
export function createCollectiveMessageWorkArtifacts(context: Pick<FeatureContext,
  'pluginInstanceId' | 'threads' | 'tasks' | 'messaging' | 'storage'>,
  materials: ReturnType<typeof createCollectiveMessageWorkMaterials>) {
  async function selection(binding: Binding) {
    await binding.revalidate();
    return {revision: binding.work.revision, artifactRefs: binding.artifactRefs};
  }
  async function locate(binding: {auth:{threadId:string;userId:string;catId:string};resultKey:string;work:{workId:string};revalidate():Promise<void>}, artifactRef: string) {
    let before: {timestamp: number; id: string} | undefined;
    const matches: {capture: NonNullable<Awaited<ReturnType<typeof materials.read>>>;
      file: NonNullable<Awaited<ReturnType<typeof materials.read>>>['files'][number]}[] = [];
    for (;;) {
      const page = await context.threads.readMessages(binding.auth.threadId, {limit: 100, ...(before ? {before} : {})});
      await binding.revalidate();
      for (const item of page) {
        const capture = await materials.read(item.id, artifactRef);await binding.revalidate();
        if (!capture || capture.message.userId !== binding.auth.userId || capture.message.catId !== binding.auth.catId ||
          capture.taskRef !== taskRefOf(binding) || capture.workId !== binding.work.workId) continue;
        for (const file of capture.files) if (file.block.url === artifactRef) matches.push({capture, file});
      }
      const last = page.at(-1);if (page.length < 100 || !last) break;
      if (before?.id === last.id && before.timestamp === last.timestamp) throw changed();
      before = {timestamp: last.timestamp, id: last.id};
    }
    if (matches.length > 1) throw changed();
    return matches[0];
  }
  async function readSelected(binding: Binding) {
    const selected = await selection(binding);
    if (!selected.artifactRefs.length) return undefined;
    if (selected.artifactRefs.length !== 1) throw changed();
    const artifactRef = selected.artifactRefs[0]!;
    const found = await locate(binding, artifactRef);
    if (!found) throw changed();
    const {capture, file} = found;
    if (file.unavailable) throw changed();
    const message = capture.message, revision = String(message.timestamp);
    const sourceRef = `message:${message.threadId}:${message.id}`;
    const originalFileName = artifactRef.slice('/uploads/'.length);
    const messageWork = /^\/uploads\/doc-[A-Za-z0-9._-]+\.md$/i.test(artifactRef);
    const supportedText = messageWork || originalFileName.startsWith('cwork-') ? file.text : undefined;
    const scope = {userId: binding.auth.userId, taskId: binding.resultKey.slice('work:'.length),
      executionRevision: binding.work.executionRevision, resultRevision: binding.work.resultRevision};
    if (messageWork && (capture.resultRevision !== scope.resultRevision || capture.executionRevision !== scope.executionRevision)) throw changed();
    const fileName = messageWork && supportedText !== undefined
      ? collectiveDocumentFileName(scope, Buffer.from(supportedText)) : originalFileName;
    if (supportedText !== undefined && !isCollectiveDocumentFile(scope, fileName, Buffer.from(supportedText))) throw changed();
    const publicationVersion = messageWork ? 2 as const : 1 as const;
    const textPublication = supportedText === undefined ? undefined : {v: publicationVersion,
      taskId: binding.resultKey.slice('work:'.length), resultRevision: capture.resultRevision,
      executionRevision: capture.executionRevision, sourceMessageId: message.id, sourceMessageRevision: message.sourceRevision,
      triggerMessageId: capture.triggerMessageId, publisherCatId: message.catId!, invocationId: capture.invocationId,
      item: {kind: 'rich-file' as const, blockId: String(file.block.id)}, contentDigest: file.contentDigest!,
      byteLength: Buffer.byteLength(supportedText), mediaType: file.block.mimeType};
    const snapshot = workResultArtifactSnapshotSchema.parse({taskRef: taskRefOf(binding), taskRevision: binding.work.revision,
      artifactRef, artifactRevision: revision, completenessRef: `${sourceRef}#available:${revision}`,
      previewRef: `${sourceRef}#preview:${revision}`,
      openInWorkspaceRef: `workspace:artifact:${message.threadId}:${revision}:${artifactRef}`,
      ...(textPublication ? {textPublication} : {})});
    await binding.revalidate();
    const latest = await selection(binding);
    if (!isDeepStrictEqual(latest, selected)) throw changed();
    // Re-read publication/trigger/bytes after the last Service/lifetime waits.
    if (!isDeepStrictEqual(await materials.read(message.id), capture)) throw changed();
    const publicationFile = supportedText === undefined ? undefined : collectiveWorkResultTextSourceSchema.parse({
      v: publicationVersion, sourceHref: artifactRef, fileName,
      mediaType: file.block.mimeType, contentDigest: file.contentDigest,
      byteLength: Buffer.byteLength(supportedText), contentBase64: Buffer.from(supportedText).toString('base64'),
    });
    return {snapshot, ...(supportedText === undefined ? {} : {text: supportedText, mediaType: file.block.mimeType}),
      ...(publicationFile ? {file: publicationFile} : {})};
  }
  return {
    async current(binding: Binding) {return selection(binding);},
    async register(binding: Binding, expectedRevision: number, artifactRefs: readonly string[]) {
      const refs = collectiveWorkArtifactRefsSchema.parse(artifactRefs);
      const selected = await selection(binding);
      if (expectedRevision !== selected.revision)
        throw collectiveContextError('WORK_ARTIFACT_REVISION_CONFLICT', 'Task data changed; reread current context');
      await binding.registerArtifactRefs(expectedRevision, refs);
      return selection(binding);
    },
    readSelected,
    /** Backfill from the original selected message and HMR capture, never from a guessed Host path. */
    async sealAccepted(scope: AssignedWorkAuthorityScope, publication: CollectiveWorkResultPublication,
      current: () => Promise<void>) {
      const original = publication.artifactSnapshot;
      if (!original || !publication.taskRef.startsWith('task:work:') || !publication.localOwnerUserId ||
        scope.hostRoute?.localOwnerUserId !== publication.localOwnerUserId ||
        scope.connection.authorizedHumanId !== publication.authorizedHumanId ||
        scope.work.workId !== publication.workId ||
        !/^\/uploads\/(?:doc-[A-Za-z0-9._-]+\.md|cwork-[A-Za-z0-9._-]+\.(?:md|txt))$/i.test(original.artifactRef)) return undefined;
      const taskId = publication.taskRef.slice('task:work:'.length);
      const task = await context.tasks.get({id:taskId});await current();
      const sourceRef = task?.entrustedWork?.admission.sourceRefs[0];
      const sourceMessage = sourceRef?.startsWith('message:')
        ? await context.messaging.get(sourceRef.slice('message:'.length)) : null;await current();
      const located = sourceMessage ? await locateCollectiveWorkTask(context.tasks, context.storage, sourceMessage,
        publication.catId, context.pluginInstanceId,{allowTerminal:true}) : undefined;await current();
      if (!task || located?.task.id !== task.id ||
        task.ownerCatId !== publication.catId || (task.userId !== null && task.userId !== publication.localOwnerUserId)) return undefined;
      const initialWork = scope.work;
      const revalidate = async () => {
        await current();
        if (!isDeepStrictEqual(await scope.readCurrentWork(), initialWork)) throw changed();
        const freshTask = sourceMessage ? (await locateCollectiveWorkTask(context.tasks, context.storage,
          sourceMessage, publication.catId, context.pluginInstanceId,{allowTerminal:true}))?.task : undefined;await current();
        if (!freshTask || freshTask.threadId !== task.threadId || freshTask.ownerCatId !== task.ownerCatId ||
          freshTask.userId !== task.userId || freshTask.subjectKey !== task.subjectKey) throw changed();
      };
      await revalidate();
      const found = await locate({auth:{userId:publication.localOwnerUserId,threadId:task.threadId,catId:publication.catId},
        resultKey:`work:${taskId}`,work:scope.work,revalidate},original.artifactRef);
      if (!found) return undefined;
      const {capture,file} = found;
      if (file.unavailable || file.text === undefined || !file.contentDigest ||
        capture.resultRevision !== publication.resultRevision ||
        capture.executionRevision !== (publication.executionRevision ?? 1) ||
        original.taskRef !== publication.taskRef || original.taskRevision !== publication.taskRevision ||
        original.artifactRevision !== String(capture.message.timestamp) ||
        original.completenessRef !== `message:${task.threadId}:${capture.message.id}#available:${capture.message.timestamp}`) throw changed();
      const bytes = Buffer.from(file.text);
      const messageWork = /^\/uploads\/doc-[A-Za-z0-9._-]+\.md$/i.test(original.artifactRef);
      const name = messageWork ? collectiveDocumentFileName({userId:publication.localOwnerUserId,taskId,
        executionRevision:capture.executionRevision,resultRevision:capture.resultRevision},bytes)
        : original.artifactRef.slice('/uploads/'.length);
      if (!isCollectiveDocumentFile({userId:publication.localOwnerUserId,taskId,
        executionRevision:capture.executionRevision,resultRevision:capture.resultRevision},name,bytes)) throw changed();
      const version = messageWork ? 2 as const : 1 as const;
      const textPublication = {v:version,taskId,resultRevision:capture.resultRevision,executionRevision:capture.executionRevision,
        sourceMessageId:capture.message.id,sourceMessageRevision:capture.message.sourceRevision,
        triggerMessageId:capture.triggerMessageId,publisherCatId:publication.catId,invocationId:capture.invocationId,
        item:{kind:'rich-file' as const,blockId:String(file.block.id)},contentDigest:file.contentDigest,
        byteLength:bytes.length,mediaType:file.block.mimeType};
      if (original.textPublication && !isDeepStrictEqual(original.textPublication,textPublication)) throw changed();
      const artifactSnapshot = workResultArtifactSnapshotSchema.parse({...original,textPublication});
      const source = collectiveWorkResultTextSourceSchema.parse({v:version,sourceHref:original.artifactRef,fileName:name,
        mediaType:file.block.mimeType,contentDigest:file.contentDigest,byteLength:bytes.length,contentBase64:bytes.toString('base64')});
      await revalidate();
      if (!isDeepStrictEqual(await materials.read(capture.message.id),capture)) throw changed();
      return {artifactSnapshot,source};
    },
    async readPrevious(connector: CollectiveConnector, binding: Binding) {
      const witness = () => connector.withAssignedWorkAuthority(binding.source.connectionId, binding.work.workId, async scope => {
        const work = scope.work;
        const prior = work.history.filter(row => row.action === 'result_returned' &&
          (row.resultRevision ?? 1) < binding.work.resultRevision).at(-1);
        if (!prior?.eventId) return undefined;
        const matches = scope.resultPublications.filter(row => row.workId === binding.work.workId &&
          row.taskRef === taskRefOf(binding) && row.localOwnerUserId === binding.auth.userId &&
          row.authorizedHumanId === work.accountableHumanId && row.assignmentEventId === binding.work.assignmentEventId &&
          row.resultEventId === prior.eventId && row.resultRevision === (prior.resultRevision ?? 1));
        if (matches.length !== 1) throw changed();return matches[0]!;
      });
      await binding.revalidate();const before = await witness();await binding.revalidate();
      if (!before) return undefined;
      const snapshot = before.artifactSnapshot;
      if (!snapshot?.textPublication) return {state: 'unavailable', code: 'UNSEALED_ARTIFACT'};
      const seal = snapshot.textPublication;
      await binding.revalidate();const after = await witness();await binding.revalidate();
      if (!isDeepStrictEqual(before, after)) throw changed();
      const capture = await materials.read(seal.sourceMessageId);
      const file = capture?.files.find(file => file.block.url === snapshot.artifactRef);
      if (!capture || !file || file.unavailable || file.text === undefined || capture.taskRef !== snapshot.taskRef ||
        capture.workId !== binding.work.workId || capture.resultRevision !== seal.resultRevision ||
        capture.executionRevision !== seal.executionRevision || capture.invocationId !== seal.invocationId ||
        capture.triggerMessageId !== seal.triggerMessageId || file.contentDigest !== seal.contentDigest ||
        capture.message.sourceRevision !== seal.sourceMessageRevision || capture.message.catId !== seal.publisherCatId) throw changed();
      return {state: 'available', text: file.text, mediaType: file.block.mimeType, snapshot,
        trust: 'untrusted_external', sourceTrust: 'unknown', instructionPolicy: 'data_only'};
    },
  };
}
