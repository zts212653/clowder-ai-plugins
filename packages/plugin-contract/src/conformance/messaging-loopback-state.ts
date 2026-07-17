import type { FixtureHandle, FixtureSetup } from '../generated/contract.generated.js';
import type { BehaviorTarget } from './behavior-executor.js';

export type LoopbackRecord = Record<string, unknown>;

export interface MessagingLoopbackState {
  callerId: string;
  grants: Set<string>;
  handles: Map<string, FixtureHandle>;
  messages: Map<string, LoopbackRecord>;
  outputEvents: LoopbackRecord[];
  ledger: Map<string, LoopbackRecord>;
  subscriptions: Map<string, LoopbackRecord>;
  replayEvents: LoopbackRecord[];
  grantState: Map<string, { visible: boolean; granted: boolean }>;
  observations: Map<BehaviorTarget, unknown>;
  eventWindow?: LoopbackRecord;
  whisperGrantTargets: Set<string>;
}

function isRecord(value: unknown): value is LoopbackRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordArray(value: unknown): LoopbackRecord[] {
  return Array.isArray(value)
    ? value.filter(isRecord).map((entry) => structuredClone(entry))
    : [];
}

function recordsByStringKey(
  records: readonly LoopbackRecord[],
  key: string,
): Map<string, LoopbackRecord> {
  const result = new Map<string, LoopbackRecord>();
  for (const record of records) {
    const value = record[key];
    if (typeof value === 'string') {
      result.set(value, record);
    }
  }
  return result;
}

export function createMessagingLoopbackState(given: FixtureSetup): MessagingLoopbackState {
  const setup = structuredClone(given);
  const rawState = setup.state as LoopbackRecord;
  const messages = recordArray(rawState.messages);
  const outputEvents = recordArray(rawState.outputEvents);
  const replayEvents = recordArray(rawState.replayEvents);
  const subscriptions = recordArray(rawState.subscriptions);
  const handles = new Map<string, FixtureHandle>();
  for (const handle of Object.values(setup.handles)) {
    handles.set(handle.token, handle);
  }

  if (isRecord(rawState.subscription) && subscriptions.length === 0) {
    const subscriptionHandle = [...handles.values()].find(
      (handle) => handle.kind === 'subscription' && handle.subscriptionId,
    );
    if (subscriptionHandle?.subscriptionId) {
      subscriptions.push({
        subscriptionId: subscriptionHandle.subscriptionId,
        ...structuredClone(rawState.subscription),
      });
    }
  }
  for (const handle of handles.values()) {
    if (handle.kind === 'subscription' && handle.subscriptionId) {
      const subscription = subscriptions.find(
        (candidate) => candidate.subscriptionId === handle.subscriptionId,
      );
      if (subscription) {
        subscription.ownerPluginInstanceId = handle.ownerPluginInstanceId;
      } else {
        subscriptions.push({
          subscriptionId: handle.subscriptionId,
          ownerPluginInstanceId: handle.ownerPluginInstanceId,
        });
      }
    }
  }

  const grantState = new Map<string, { visible: boolean; granted: boolean }>();
  if (isRecord(rawState.grantState)) {
    for (const [capability, value] of Object.entries(rawState.grantState)) {
      if (
        isRecord(value) &&
        typeof value.visible === 'boolean' &&
        typeof value.granted === 'boolean'
      ) {
        grantState.set(capability, {
          visible: value.visible,
          granted: value.granted,
        });
      }
    }
  }

  const ledgerRecords = recordArray(rawState.idempotencyLedger);
  const observations = new Map<BehaviorTarget, unknown>([
    ['messages', messages],
    ['output_events', outputEvents],
    ['idempotency_ledger', ledgerRecords],
    [
      'subscription',
      rawState.subscription ?? rawState.subscriptions,
    ],
    ['snapshot', rawState.snapshot],
    ['reply_preview', rawState.replyPreview],
    ['provenance', rawState.provenance],
    ['grant_state', rawState.grantState],
    ['permission_matrix', rawState.permissionMatrix],
    ['replay_events', replayEvents],
  ]);

  return {
    callerId: setup.caller.pluginInstanceId,
    grants: new Set(setup.grants),
    handles,
    messages: recordsByStringKey(messages, 'messageId'),
    outputEvents,
    ledger: recordsByStringKey(ledgerRecords, 'idempotencyKey'),
    subscriptions: recordsByStringKey(subscriptions, 'subscriptionId'),
    replayEvents,
    grantState,
    observations,
    eventWindow: isRecord(rawState.eventWindow)
      ? structuredClone(rawState.eventWindow)
      : undefined,
    whisperGrantTargets: new Set(
      Array.isArray(rawState.whisperGrantTargets)
        ? rawState.whisperGrantTargets.filter(
            (target): target is string => typeof target === 'string',
          )
        : [],
    ),
  };
}
