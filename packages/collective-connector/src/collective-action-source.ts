import type { FeatureContext, PluginActionContext, PluginMessage } from '@clowder-ai/plugin-sdk';

/** Package-local business input assembled from the injected call and ordinary message data. */
export interface CollectiveActionSource {
  readonly pluginInstanceId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly catId: string;
  readonly invocationId: string;
  readonly originTriggerMessageId: string;
  readonly source: PluginMessage;
}
export async function readCollectiveActionSource(
  context: Pick<FeatureContext, 'pluginInstanceId' | 'messaging'>,
  action: PluginActionContext,
): Promise<CollectiveActionSource> {
  await action.assertCurrent();
  if (!action.originTriggerMessageId || !context.messaging.get) throw new Error('Current source message unavailable');
  const source = await context.messaging.get(action.originTriggerMessageId);
  await action.assertCurrent();
  if (!source) throw new Error('Current source message unavailable');
  return { pluginInstanceId: context.pluginInstanceId, userId: action.userId, threadId: action.threadId,
    catId: action.catId, invocationId: action.invocationId, originTriggerMessageId: action.originTriggerMessageId, source };
}
