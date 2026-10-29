import {
  COLLECTIVE_CHANNEL_CREATE_LIMIT,
  collectiveChannelCreateRequestSchema,
  collectiveChannelNameKey,
  type CollectiveChannelCreateResponse,
  type CollectiveChannelProjection,
} from '../contracts/index.js';
import { channelRecordKey, findChannel, listChannelRecords, projectChannel } from './channel-authority.js';
import { CollectiveServiceError } from './errors.js';
import { requireHumanAuthBinding, requireMembership, requireSteward, resolveSession } from './identity-store.js';
import type { PersistentServiceState } from './persistence.js';

export class CollectiveChannelStore {
  constructor(
    private readonly persistence: PersistentServiceState,
    private readonly now: () => number,
  ) {}

  list(sessionToken: string, collectiveId: string): CollectiveChannelProjection[] {
    const state = this.persistence.snapshot();
    const { human } = resolveSession(state, sessionToken);
    requireHumanAuthBinding(state, human.humanId);
    requireMembership(state, collectiveId, human.humanId);
    return listChannelRecords(state, collectiveId).map((channel) => projectChannel(state, channel));
  }

  create(sessionToken: string, unsafeInput: unknown): Promise<CollectiveChannelCreateResponse> {
    const parsed = collectiveChannelCreateRequestSchema.safeParse(unsafeInput);
    if (!parsed.success) {
      throw new CollectiveServiceError('CHANNEL_INVALID', 'Channel name or operation identity is invalid', 400);
    }
    const input = parsed.data;
    return this.persistence.transaction((state) => {
      const { human } = resolveSession(state, sessionToken);
      requireHumanAuthBinding(state, human.humanId);
      requireSteward(state, input.collectiveId, human.humanId);
      const operation = listChannelRecords(state, input.collectiveId).find(
        (channel) =>
          channel.createdVia === 'human' &&
          channel.createdByHumanId === human.humanId &&
          channel.clientOperationId === input.clientOperationId,
      );
      if (operation) {
        if (collectiveChannelNameKey(operation.channelId) !== collectiveChannelNameKey(input.name)) {
          throw new CollectiveServiceError(
            'CHANNEL_OPERATION_CONFLICT',
            'Channel operation identity was reused for a different name',
            409,
          );
        }
        return { status: 'replayed', channel: projectChannel(state, operation) };
      }
      const existing = findChannel(state, input.collectiveId, input.name);
      if (existing) return { status: 'existing', channel: projectChannel(state, existing) };
      if (listChannelRecords(state, input.collectiveId).length >= COLLECTIVE_CHANNEL_CREATE_LIMIT) {
        throw new CollectiveServiceError('CHANNEL_LIMIT_REACHED', 'Collective channel limit was reached', 409);
      }
      const channel = {
        v: 1 as const,
        collectiveId: input.collectiveId,
        channelId: input.name,
        visibility: 'public' as const,
        createdByHumanId: human.humanId,
        createdAt: new Date(this.now()).toISOString(),
        revision: 1 as const,
        createdVia: 'human' as const,
        clientOperationId: input.clientOperationId,
      };
      state.channels[channelRecordKey(channel.collectiveId, channel.channelId)] = channel;
      return { status: 'created', channel: projectChannel(state, channel) };
    });
  }
}
