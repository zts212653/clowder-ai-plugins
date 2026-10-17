import {isDeepStrictEqual} from 'node:util';
import type {FeatureContext} from '@clowder-ai/plugin-sdk';
import type {CollectiveConnector} from './business/connector/connector.js';
import {workResultArtifactSnapshotSchema} from './business/connector/state.js';
import {collectiveContextError} from './collective-context-refs.js';
import type {createCollectiveMessageWorkCaller} from './collective-message-work.js';
import type {createCollectiveMessageWorkMaterials} from './collective-message-work-materials.js';
import {collectiveWorkArtifactRefsSchema} from './work-native-methods.js';

type Binding = Parameters<Parameters<ReturnType<typeof createCollectiveMessageWorkCaller>['withCurrentMessage']>[1]>[0];
const changed = () => collectiveContextError('WORK_ARTIFACT_UNAVAILABLE', 'Explicitly selected Work material is unavailable or changed');
const taskRefOf = (binding: Binding) => `task:${binding.resultKey}`;

/** Original explicit selection belongs to the same canonical Task as Schedule.
 * Private captured publication bytes are data, never another selection owner. */
export function createCollectiveMessageWorkArtifacts(context: Pick<FeatureContext, 'threads'>,
  materials: ReturnType<typeof createCollectiveMessageWorkMaterials>) {
  async function selection(binding: Binding) {
    await binding.revalidate();
    return {revision: binding.work.revision, artifactRefs: binding.artifactRefs};
  }
  async function locate(binding: Binding, artifactRef: string) {
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
    if (matches.length !== 1) throw changed();
    return matches[0]!;
  }
  async function readSelected(binding: Binding) {
    const selected = await selection(binding);
    if (!selected.artifactRefs.length) return undefined;
    if (selected.artifactRefs.length !== 1) throw changed();
    const artifactRef = selected.artifactRefs[0]!;
    const {capture, file} = await locate(binding, artifactRef);
    if (file.unavailable) throw changed();
    const message = capture.message, revision = String(message.timestamp);
    const sourceRef = `message:${message.threadId}:${message.id}`;
    const textPublication = file.text === undefined ? undefined : {v: 1 as const,
      taskId: binding.resultKey.slice('work:'.length), resultRevision: capture.resultRevision,
      executionRevision: capture.executionRevision, sourceMessageId: message.id, sourceMessageRevision: message.sourceRevision,
      triggerMessageId: capture.triggerMessageId, publisherCatId: message.catId!, invocationId: capture.invocationId,
      item: {kind: 'rich-file' as const, blockId: String(file.block.id)}, contentDigest: file.contentDigest!,
      byteLength: Buffer.byteLength(file.text), mediaType: file.block.mimeType};
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
    return {snapshot, ...(file.text === undefined ? {} : {text: file.text, mediaType: file.block.mimeType})};
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
