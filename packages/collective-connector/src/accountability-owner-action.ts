import { readCollectiveProjectAttentionSource } from './project-attention-source.js';
import { z } from 'zod';
import type { OperationActionResult } from '@clowder-ai/plugin-contract';
import type { PluginActionHandler } from '@clowder-ai/plugin-sdk';
import type { CollectiveConnector } from './business/connector/connector.js';
import { readCollectiveAccountabilityAttentionSource } from './accountability-attention.js';
import { collectiveOwnerOperationInput } from './owner-operation-input.js';

/** Dot uses the ordinary authenticated owner operation; source decisions remain here. */
export function createAccountabilityAttentionAction(
  connector: CollectiveConnector,
  assertActive: () => void,
): PluginActionHandler {
  return async (input, native, caller): Promise<OperationActionResult> => {
    if (
      native ||
      caller?.kind !== 'owner-operation' ||
      caller.operationKey !== 'accountability' ||
      caller.actionId !== 'attention'
    )
      throw new Error('Accountability attention requires its authenticated owner operation');
    z.object({ input: z.object({}).strict() })
      .strict()
      .parse(collectiveOwnerOperationInput(input));
    const current = async () => {
      assertActive();
      caller.signal.throwIfAborted();
      await caller.assertCurrent();
      assertActive();
      caller.signal.throwIfAborted();
    };
    await current();
    const [data, projectRead] = await Promise.all([
      readCollectiveAccountabilityAttentionSource(connector, caller.userId, current),
      readCollectiveProjectAttentionSource(connector, caller.userId, current),
    ]);
    await current();
    return { render: 'status', data: { ...data, projectRead } };
  };
}
