import { matterDispatchSchema } from '@clowder-ai/plugin-memory-contract/matter';
import { MemoryCueEpisodeStore } from '../cue/MemoryCueEpisodeStore.js';
import { MatterMemoryService, type MatterMemoryDeps } from '../matters/MatterMemoryService.js';
import { matterOpeningDirectory } from '../matters/matter-opening-directory.js';
import { type MatterActor, MatterMemoryError } from '../matters/matter-source.js';

export interface MatterCallAuthority {
  userId: string;
  viewer: MatterActor['viewer'];
  publicReply?: boolean;
  threadId: string;
  invocationId: string;
  triggerMessageId?: string;
}

export function createMatterDispatch(
  store: Pick<MatterMemoryDeps, 'db' | 'runWrite'>,
  source: Omit<MatterMemoryDeps, 'db' | 'runWrite' | 'appendMatterRead' | 'onChanged'> & {
    caller(): Promise<MatterCallAuthority>;
    publishMatterChange(): Promise<void>;
  },
) {
  const cueStore = new MemoryCueEpisodeStore(store.db);
  const service = new MatterMemoryService({
    ...source,
    ...store,
    appendMatterRead: (input) => cueStore.appendMatterRead(input),
    onChanged: source.publishMatterChange,
  });
  return (value: unknown) => dispatchMatter(service, source.caller, value);
}

export async function dispatchMatter(
  service: MatterMemoryService,
  caller: () => Promise<MatterCallAuthority>,
  value: unknown,
) {
  const request = matterDispatchSchema.parse(value);
  const { userId, viewer, publicReply, threadId, invocationId, triggerMessageId } = await caller();
  const actor = {
    userId,
    viewer,
    publicReply,
    ...(viewer.type === 'cat' ? { invocation: { threadId, triggerMessageId } } : {}),
  };
  try {
    switch (request.operation) {
      case 'matter.opening':
        if (viewer.type !== 'cat') throw new MatterMemoryError('not_available');
        return await matterOpeningDirectory(service, userId, viewer.catId, threadId, { invocationId });
      case 'matter.catalog':
        return await service.catalog(actor, { ...request.input, ...(viewer.type === 'cat' ? { threadId } : {}) });
      case 'matter.read':
        return await service.read(actor, request.input.matterId, request.input.options);
      case 'matter.read_for_invocation':
        if (viewer.type !== 'cat') throw new MatterMemoryError('not_available');
        return await service.readForInvocation(
          { ownerUserId: userId, threadId, invocationId }, viewer.catId, request.input.matterId, request.input.options,
        );
      case 'matter.write':
        return await service.write(actor, request.input);
      case 'matter.write_snapshot':
        return await service.writeSnapshot(actor, request.input.matterId, request.input.ref);
      case 'matter.select_source':
        return await service.selectSource(request.input);
      case 'matter.project':
        return await service.project(actor, request.input.matterId);
      case 'matter.read_receipt':
        if (viewer.type !== 'cat') throw new MatterMemoryError('not_available');
        return await service.readReceipt(userId, viewer.catId, request.input, publicReply);
    }
  } catch (error) {
    if (!(error instanceof MatterMemoryError)) throw error;
    return { status: 'rejected' as const, code: error.code, ...(error.detail ? { detail: error.detail } : {}) };
  }
}
