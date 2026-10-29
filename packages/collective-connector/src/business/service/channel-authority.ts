import type { CollectiveChannelProjection } from '../contracts/index.js';
import { collectiveChannelNameKey } from '../contracts/index.js';
import { CollectiveServiceError } from './errors.js';
import type { ChannelRecord, ServiceState } from './state.js';

export function channelRecordKey(collectiveId: string, channelId: string): string {
  return JSON.stringify([collectiveId, channelId]);
}

export function listChannelRecords(state: ServiceState, collectiveId: string): readonly ChannelRecord[] {
  return Object.values(state.channels)
    .filter((channel) => channel.collectiveId === collectiveId)
    .sort((left, right) => {
      if (left.channelId === 'general') return right.channelId === 'general' ? 0 : -1;
      if (right.channelId === 'general') return 1;
      return left.createdAt.localeCompare(right.createdAt) || left.channelId.localeCompare(right.channelId);
    });
}

export function findChannel(
  state: ServiceState,
  collectiveId: string,
  channelId: string,
): ChannelRecord | undefined {
  const key = collectiveChannelNameKey(channelId);
  return listChannelRecords(state, collectiveId).find(
    (channel) => collectiveChannelNameKey(channel.channelId) === key,
  );
}

export function requirePublicChannel(state: ServiceState, collectiveId: string, channelId: string): ChannelRecord {
  const channel = state.channels[channelRecordKey(collectiveId, channelId)];
  if (!channel) throw new CollectiveServiceError('CHANNEL_NOT_FOUND', 'Channel was not found', 404);
  return channel;
}

export function projectChannel(state: ServiceState, channel: ChannelRecord): CollectiveChannelProjection {
  const creator = state.humans[channel.createdByHumanId];
  if (!creator) throw new CollectiveServiceError('STATE_CORRUPT', 'Channel creator is unavailable', 500);
  return {
    serviceInstanceId: state.serviceInstanceId,
    collectiveId: channel.collectiveId,
    channelId: channel.channelId,
    visibility: channel.visibility,
    createdBy: {
      humanId: creator.humanId,
      displayName: creator.displayName,
      ...(creator.avatarUrl ? { avatarUrl: creator.avatarUrl } : {}),
    },
    createdAt: channel.createdAt,
    revision: channel.revision,
  };
}

export function initialChannelRecord(input: {
  readonly collectiveId: string;
  readonly createdByHumanId: string;
  readonly createdAt: string;
  readonly createdVia: ChannelRecord['createdVia'];
}): ChannelRecord {
  return {
    v: 1,
    collectiveId: input.collectiveId,
    channelId: 'general',
    visibility: 'public',
    createdByHumanId: input.createdByHumanId,
    createdAt: input.createdAt,
    revision: 1,
    createdVia: input.createdVia,
  };
}
