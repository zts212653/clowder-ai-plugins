import { isDeepStrictEqual } from 'node:util';

import {
  CAPABILITY_TABLE,
  type AppendOperationInput,
  type Capability,
  type DeleteReplayEventsInput,
  type FixtureHandle,
  type FixtureOperation,
  type FixtureSetup,
  type MessagingErrorCode,
  type OnMessageDeliveryInput,
  type PermissionMatrixEntry,
  type SendOperationInput,
} from '../generated/contract.generated.js';
import type {
  BehaviorAdapter,
  BehaviorTarget,
  BehaviorVerdict,
} from './behavior-executor.js';
import {
  createMessagingLoopbackState,
  type LoopbackRecord,
  type MessagingLoopbackState,
} from './messaging-loopback-state.js';

function isRecord(value: unknown): value is LoopbackRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function error(errorCode: MessagingErrorCode): BehaviorVerdict {
  return { status: 'error', errorCode };
}

const success: BehaviorVerdict = { status: 'success' };

type SubscriptionAccess =
  | { readonly ok: true; readonly subscription: LoopbackRecord }
  | { readonly ok: false; readonly verdict: BehaviorVerdict };

type ScopedHandle = FixtureHandle & { readonly threadId: string };
type ScopedHandleAccess =
  | { readonly ok: true; readonly handle: ScopedHandle }
  | { readonly ok: false; readonly verdict: BehaviorVerdict };

function assertNever(value: never): never {
  throw new Error(`Unsupported fixture operation: ${JSON.stringify(value)}`);
}

export class MessagingLoopbackAdapter implements BehaviorAdapter {
  private state?: MessagingLoopbackState;

  async setup(given: FixtureSetup): Promise<void> {
    this.state = createMessagingLoopbackState(given);
  }

  async observe(target: BehaviorTarget): Promise<unknown> {
    return structuredClone(this.requireState().observations.get(target));
  }

  async execute(operation: FixtureOperation): Promise<BehaviorVerdict> {
    switch (operation.operation) {
      case 'send':
        return this.send(operation.input);
      case 'appendElements':
        return this.appendElements(operation.input);
      case 'subscribe':
        return this.subscribe(operation.input.handleId);
      case 'read':
        return this.read(operation.input.subscriptionId);
      case 'ack':
        return this.ack(operation.input.subscriptionId, operation.input.ackToken);
      case 'snapshot':
        return this.snapshot(operation.input.subscriptionId);
      case 'applyGrantPreset':
        return this.applyGrantPreset(operation.input.capabilities);
      case 'revokeGrant':
        return this.revokeGrant(operation.input.capability);
      case 'deliverOnMessage':
        return this.deliverOnMessage(operation.input);
      case 'checkPermissionMatrix':
        return this.checkPermissionMatrix(operation.input.entries);
      case 'deleteReplayEvents':
        return this.deleteReplayEvents(operation.input);
      default:
        return assertNever(operation);
    }
  }

  private requireState(): MessagingLoopbackState {
    if (!this.state) {
      throw new Error('MessagingLoopbackAdapter.setup must be called before use');
    }
    return this.state;
  }

  private accessScopedHandle(
    token: unknown,
    kind: FixtureHandle['kind'],
  ): ScopedHandleAccess {
    const state = this.requireState();
    if (typeof token !== 'string') {
      return { ok: false, verdict: error('VALIDATION') };
    }
    const handle = state.handles.get(token);
    if (!handle || handle.kind !== kind) {
      return { ok: false, verdict: error('NOT_FOUND') };
    }
    if (handle.ownerPluginInstanceId !== state.callerId) {
      return { ok: false, verdict: error('PERMISSION') };
    }
    if (typeof handle.threadId !== 'string' || handle.threadId.length === 0) {
      return { ok: false, verdict: error('NOT_FOUND') };
    }
    return { ok: true, handle: handle as ScopedHandle };
  }

  private accessSubscription(subscriptionId: string): SubscriptionAccess {
    const state = this.requireState();
    if (!state.grants.has('message.event.subscribe')) {
      return { ok: false, verdict: error('PERMISSION') };
    }
    const subscription = state.subscriptions.get(subscriptionId);
    if (!subscription) {
      return { ok: false, verdict: error('NOT_FOUND') };
    }
    if (subscription.ownerPluginInstanceId !== state.callerId) {
      return { ok: false, verdict: error('PERMISSION') };
    }
    return { ok: true, subscription };
  }

  private send(input: SendOperationInput): BehaviorVerdict {
    const state = this.requireState();
    if (!state.grants.has('messaging.send')) {
      return error('PERMISSION');
    }

    const rawInput = input as unknown as LoopbackRecord;
    const address = input.address;
    if (address.kind === 'thread_id') {
      return error('PERMISSION');
    }
    if (
      address.kind !== 'thread_handle' &&
      address.kind !== 'connector_binding'
    ) {
      return error('VALIDATION');
    }
    const targetAccess = this.accessScopedHandle(address.handle, address.kind);
    if (!targetAccess.ok) {
      return targetAccess.verdict;
    }
    const { handle: target } = targetAccess;

    const audience = rawInput.draftAudience;
    if (isRecord(audience) && audience.kind === 'system') {
      return error('VALIDATION');
    }
    if (isRecord(audience) && audience.kind === 'whisper') {
      const targets = audience.targets;
      if (
        !Array.isArray(targets) ||
        targets.some(
          (target) => typeof target !== 'string' || !state.whisperGrantTargets.has(target),
        )
      ) {
        return error('PERMISSION');
      }
    }

    const provenance = input.payload.provenance;
    if (isRecord(provenance) && isRecord(provenance.origin)) {
      const origin = provenance.origin;
      if (
        origin.kind === 'plugin' &&
        origin.instanceId !== state.callerId
      ) {
        return error('PERMISSION');
      }
    }

    const replyTo = rawInput.replyTo;
    if (replyTo !== undefined) {
      if (typeof replyTo !== 'string') {
        return error('VALIDATION');
      }
      const reply = state.messages.get(replyTo);
      if (!reply || reply.threadId !== target.threadId) {
        return error('VALIDATION');
      }
      state.observations.set('reply_preview', { messageId: replyTo });
    }

    const messageId = `loopback-message-${state.messages.size + 1}`;
    const message = {
      messageId,
      threadId: target.threadId,
      revision: 1,
      payload: structuredClone(input.payload),
    };
    const event = { eventId: `loopback-event-${state.outputEvents.length + 1}`, messageId };
    const ledgerEntry = { idempotencyKey: input.idempotencyKey, messageId };
    state.messages.set(messageId, message);
    state.outputEvents.push(event);
    state.ledger.set(input.idempotencyKey, ledgerEntry);
    state.observations.set('messages', [...state.messages.values()]);
    state.observations.set('output_events', state.outputEvents);
    state.observations.set('idempotency_ledger', [...state.ledger.values()]);
    state.observations.set('provenance', provenance);
    return success;
  }

  private appendElements(input: AppendOperationInput): BehaviorVerdict {
    const state = this.requireState();
    if (!state.grants.has('messaging.appendElements')) {
      return error('PERMISSION');
    }

    const rawHandle = input.handle;
    const handleAccess = this.accessScopedHandle(rawHandle.token, 'message_handle');
    if (!handleAccess.ok) {
      return handleAccess.verdict;
    }
    const { handle } = handleAccess;
    if (typeof handle.messageId !== 'string' || handle.messageId.length === 0) {
      return error('NOT_FOUND');
    }
    const message = state.messages.get(handle.messageId);
    if (!message) {
      return error('NOT_FOUND');
    }
    if (
      typeof message.threadId !== 'string' ||
      message.threadId !== handle.threadId
    ) {
      return error('VALIDATION');
    }

    const baseRevision = (input as unknown as LoopbackRecord).baseRevision;
    if (baseRevision !== undefined && baseRevision !== message.revision) {
      return error('CONFLICT');
    }
    const existingElements = Array.isArray(message.elements) ? message.elements : [];
    for (const candidate of input.elements) {
      if (!isRecord(candidate) || typeof candidate.elementId !== 'string') {
        return error('VALIDATION');
      }
      if (typeof candidate.derivedFromElementId === 'string') {
        const source = existingElements.find(
          (element) =>
            isRecord(element) && element.elementId === candidate.derivedFromElementId,
        );
        if (
          isRecord(source) &&
          source.epistemicStatus === 'inference' &&
          candidate.epistemicStatus === 'user_intent'
        ) {
          return error('VALIDATION');
        }
      }
    }

    message.elements = [...existingElements, ...structuredClone(input.elements)];
    message.revision = typeof message.revision === 'number' ? message.revision + 1 : 1;
    const event = {
      eventId: `loopback-event-${state.outputEvents.length + 1}`,
      messageId: handle?.messageId,
      operationId: input.operationId,
    };
    state.outputEvents.push(event);
    state.ledger.set(input.operationId, { operationId: input.operationId });
    state.observations.set('messages', [...state.messages.values()]);
    state.observations.set('output_events', state.outputEvents);
    state.observations.set('idempotency_ledger', [...state.ledger.values()]);
    return success;
  }

  private subscribe(handleId: string): BehaviorVerdict {
    const state = this.requireState();
    if (!state.grants.has('message.event.subscribe')) {
      return error('PERMISSION');
    }
    const handleAccess = this.accessScopedHandle(handleId, 'thread_handle');
    if (!handleAccess.ok) {
      return handleAccess.verdict;
    }
    const { handle } = handleAccess;
    const subscriptionId = `loopback-subscription-${state.subscriptions.size + 1}`;
    const subscription = {
      subscriptionId,
      ownerPluginInstanceId: state.callerId,
      threadId: handle.threadId,
      cursorSequence: 0,
      ackedSequence: 0,
    };
    state.subscriptions.set(subscriptionId, subscription);
    state.observations.set('subscription', subscription);
    return success;
  }

  private read(subscriptionId: string): BehaviorVerdict {
    const state = this.requireState();
    const access = this.accessSubscription(subscriptionId);
    if (!access.ok) {
      return access.verdict;
    }
    const { subscription } = access;
    const cursor = subscription.cursorSequence;
    const oldest = state.eventWindow?.oldestSequence;
    if (typeof cursor === 'number' && typeof oldest === 'number' && cursor < oldest) {
      const head = state.eventWindow?.headSequence;
      if (typeof head !== 'number') {
        return error('VALIDATION');
      }
      state.observations.set('subscription', {
        stale: true,
        ackToken: null,
        events: [],
      });
      state.observations.set('snapshot', {
        operation: 'snapshot',
        resumeSequence: head,
        nextReadStartsAfter: head,
      });
      return success;
    }
    state.observations.set('subscription', {
      stale: false,
      ackToken: null,
      events: [],
    });
    return success;
  }

  private ack(subscriptionId: string, ackToken: string): BehaviorVerdict {
    const state = this.requireState();
    const access = this.accessSubscription(subscriptionId);
    if (!access.ok) {
      return access.verdict;
    }
    const { subscription } = access;
    const tokenHandle = state.handles.get(ackToken);
    if (
      !tokenHandle ||
      tokenHandle.kind !== 'subscription' ||
      tokenHandle.subscriptionId !== subscriptionId ||
      tokenHandle.ownerPluginInstanceId !== state.callerId
    ) {
      return error('VALIDATION');
    }
    subscription.ackedSequence = subscription.cursorSequence ?? 0;
    state.observations.set('subscription', subscription);
    return success;
  }

  private snapshot(subscriptionId: string): BehaviorVerdict {
    const state = this.requireState();
    const access = this.accessSubscription(subscriptionId);
    if (!access.ok) {
      return access.verdict;
    }
    const head = state.eventWindow?.headSequence;
    if (typeof head !== 'number') {
      return error('VALIDATION');
    }
    state.observations.set('snapshot', {
      operation: 'snapshot',
      resumeSequence: head,
      nextReadStartsAfter: head,
    });
    return success;
  }

  private applyGrantPreset(capabilities: readonly Capability[]): BehaviorVerdict {
    const state = this.requireState();
    const l1 = new Set<Capability>(CAPABILITY_TABLE.L1);
    if (capabilities.some((capability) => !l1.has(capability))) {
      return error('PERMISSION');
    }
    for (const capability of capabilities) {
      state.grants.add(capability);
      state.grantState.set(capability, { visible: true, granted: true });
    }
    state.observations.set(
      'grant_state',
      Object.fromEntries(state.grantState),
    );
    return success;
  }

  private revokeGrant(capability: Capability): BehaviorVerdict {
    const state = this.requireState();
    const current = state.grantState.get(capability);
    if (!current) {
      return error('NOT_FOUND');
    }
    state.grants.delete(capability);
    state.grantState.set(capability, { visible: current.visible, granted: false });
    state.observations.set('grant_state', {
      capability,
      visible: current.visible,
      granted: false,
    });
    return success;
  }

  private deliverOnMessage(input: OnMessageDeliveryInput): BehaviorVerdict {
    const state = this.requireState();
    if (!state.grants.has('onMessage')) {
      return error('PERMISSION');
    }
    const handleAccess = this.accessScopedHandle(input.threadHandle, 'thread_handle');
    if (!handleAccess.ok) {
      return handleAccess.verdict;
    }
    const envelopeThreadId = input.envelope.threadId;
    if (
      typeof envelopeThreadId !== 'string' ||
      envelopeThreadId.length === 0 ||
      envelopeThreadId !== handleAccess.handle.threadId
    ) {
      return error('VALIDATION');
    }
    return success;
  }

  private checkPermissionMatrix(entries: readonly PermissionMatrixEntry[]): BehaviorVerdict {
    const expected = Object.entries(CAPABILITY_TABLE).flatMap(([layer, capabilities]) =>
      capabilities.map((capability) => ({
        capability,
        layer,
        firstPartyPreset: layer === 'L1',
      })),
    );
    const uniqueCapabilities = new Set(entries.map(({ capability }) => capability));
    if (
      entries.length !== expected.length ||
      uniqueCapabilities.size !== expected.length ||
      !expected.every((expectedEntry) =>
        entries.some((entry) => isDeepStrictEqual(entry, expectedEntry)),
      )
    ) {
      return error('VALIDATION');
    }
    this.requireState().observations.set('permission_matrix', {
      complete: true,
      firstPartyPresetLayers: ['L1'],
      defaultWhisperTargets: [],
    });
    return success;
  }

  private deleteReplayEvents(input: DeleteReplayEventsInput): BehaviorVerdict {
    const state = this.requireState();
    const access = this.accessSubscription(input.subscriptionId);
    if (!access.ok) {
      return access.verdict;
    }
    state.replayEvents = state.replayEvents.filter(
      (event) =>
        event.subscriptionId !== input.subscriptionId ||
        typeof event.sequence !== 'number' ||
        event.sequence > input.throughSequence,
    );
    state.observations.set('replay_events', state.replayEvents);
    return success;
  }
}
