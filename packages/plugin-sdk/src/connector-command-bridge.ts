import type { FeatureContext } from './feature-context.js';
import { createHash } from 'node:crypto';
import { createConnectorPermissionStore } from './connector-permissions.js';
import { createConnectorCommandService, type ConnectorCommandServices } from './connector-command-service.js';
import { createConnectorCommandRouter, type ConnectorCommandIngress, type ConnectorCommandResult } from './connector-command-router.js';

/** Shared command business; provider facts, replies and provider task completion
 * remain in the connector. No Host private store, URL or caller identity. */
export function createConnectorCommandBridge(context: FeatureContext, options: {
  readonly connectorId: string;
  readonly identityId: string;
  bindingChanged: ConnectorCommandServices['bindingChanged'];
  reply(input: ConnectorCommandIngress, result: ConnectorCommandResult): Promise<void>;
  settle(input: ConnectorCommandIngress): Promise<void>;
}) {
  const permissions = createConnectorPermissionStore(context.storage);
  const execute = createConnectorCommandService({ connectorId: options.connectorId,
    threads: context.threads, permissions, bindingChanged: options.bindingChanged,
    now: Date.now });
  // Host's durable ledger is scoped to plugin instance + key, not chat or
  // target thread. Match the router's chat/event identity without exposing
  // unbounded provider IDs or ambiguous delimiter concatenation.
  const sourceKey = (input: ConnectorCommandIngress, purpose: 'audit' | 'body') =>
    `connector-command:${createHash('sha256').update(JSON.stringify([
      options.connectorId, input.chatId, input.providerMessageId,
    ])).digest('hex')}:${purpose}`;
  return createConnectorCommandRouter({
    getPermissions: permissions.get,
    execute,
    reply: (_chatId, response, result, input) => options.reply(input, result ?? { response }),
    settle: options.settle,
    async audit(input, response) {
      const thread = await context.threads.ensureSystemThread();
      await context.messaging.send(thread.id, {
        idempotencyKey: sourceKey(input, 'audit'),
        payload: { provenance: { epistemicStatus: 'observation' },
          elements: [{ elementId: 'command', kind: 'text', payload: { text: `${input.text}\n${response}` } }] },
      });
    },
    async forward(input, body) {
      await context.messaging.send(body.threadId, {
        identity: options.identityId, idempotencyKey: sourceKey(input, 'body'),
        sourceEventId: input.providerMessageId,
        ...(input.senderId === undefined ? {} : { sender: { id: input.senderId } }),
        wake: body.catId === undefined ? 'auto' : { catId: body.catId },
        payload: { provenance: { epistemicStatus: 'observation', origin: { kind: 'external', connectorId: options.connectorId,
          sourceAddress: { connectorId: options.connectorId, chatId: input.chatId, messageId: input.providerMessageId } } },
          elements: [{ elementId: 'body', kind: 'text', payload: { text: body.text } }] },
      });
    },
  });
}
