import { createHash } from 'node:crypto';
import type { PluginMessagingHost } from '@clowder-ai/plugin-sdk';
import type { AutomationState, TaskItem, WaitTerminationEventV1 } from '../../model/index.js';

/** Package-local ports preserving the moved lifecycle's call sites. No Host domain imports. */
export interface ITaskStore {
  get(id: string): Promise<TaskItem | null>;
  listByKind(kind: TaskItem['kind']): Promise<readonly TaskItem[]>;
  replaceAutomationStateIfGeneration(id: string, input: {
    readonly expectedGeneration: number | null;
    readonly expectedUpdatedAt: number;
    readonly automationState: AutomationState;
    readonly status: TaskItem['status'];
  }): Promise<TaskItem | null>;
  patchAutomationState(id: string, patch: Partial<AutomationState>): Promise<TaskItem | null>;
}

export interface IWaitLifecycleEventLog {
  append(event: WaitTerminationEventV1): Promise<unknown>;
}

export interface ConnectorDeliveryInput {
  readonly threadId: string;
  readonly userId: string;
  readonly catId: string;
  readonly content: string;
  readonly idempotencyKey: string;
  readonly source: {
    readonly connector: string;
    readonly label: string;
    readonly icon: string;
    readonly url: string;
    readonly meta: Readonly<Record<string, unknown>>;
  };
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface ConnectorDeliveryDeps {
  readonly messaging: Pick<PluginMessagingHost, 'send'>;
}

export function deliverConnectorMessage(deps: ConnectorDeliveryDeps, input: ConnectorDeliveryInput) {
  // Preserve every previously valid receipt/payload. Only identifiers that could
  // never satisfy the public message contract receive a stable digest coordinate.
  const digest = createHash('sha256').update(input.idempotencyKey).digest('hex');
  const idempotencyKey = input.idempotencyKey.length <= 200 ? input.idempotencyKey : `github-notification:${digest}`;
  const elementId = input.idempotencyKey.length <= 128 ? input.idempotencyKey : `text:${digest}`;
  return deps.messaging.send({
    threadId: input.threadId,
    identity: input.source.connector,
    idempotencyKey,
    payload: { provenance: { epistemicStatus: 'observation' }, elements: [
      { elementId, kind: 'text', payload: { text: input.content } },
    ] },
    wake: { catId: input.catId },
    url: input.source.url,
    meta: { ...input.extra, ...input.source.meta },
  });
}

export { automationGeneration } from './TaskAutomationState.js';
