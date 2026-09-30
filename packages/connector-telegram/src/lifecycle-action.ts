import {
  decideLifecycleTransition,
  defineLifecycleAction,
  lifecycleRejectReason,
  type FeatureContext,
  type LifecycleAction,
} from '@clowder-ai/plugin-sdk';

type LifecycleEvent = Parameters<LifecycleAction>[0];
type SettledEvent = Extract<LifecycleEvent, { readonly state: 'settled' }>;

export interface ConnectorLifecycleCallbacks {
  sendPlaceholder(externalConversationId: string, text: string): Promise<string>;
  editPlaceholder(
    externalConversationId: string,
    platformMessageId: string,
    text: string,
    phase: 'catching_up' | 'blocked',
    lifecycleId: string,
  ): Promise<boolean>;
  sendRecovery(externalConversationId: string, text: string): Promise<void>;
  /** Resolve the sender display name recorded for a Host message id; only connectors with a reply-sender mapping implement this. */
  resolveReplySenderName?(replyTo: string): Promise<string | undefined>;
  onPlaceholder?(
    externalConversationId: string,
    platformMessageId: string,
    lifecycleId: string,
  ): void | Promise<void>;
  settle(input: {
    readonly externalConversationId: string;
    readonly platformMessageId?: string;
    readonly actorDisplayName: string;
    readonly recoveryText?: string;
    readonly event: SettledEvent;
  }): Promise<void>;
}

/**
 * A platform side effect that was accepted into state but not yet confirmed
 * complete. Written with the pre-write, cleared by the post-write once the
 * effect ran; a redelivery that finds the marker re-executes the effect once
 * more. The recovery hint is best-effort at-least-once: per-binding failures
 * are swallowed, so if an edit and its fallback recovery send both fail, the
 * hint is lost for good.
 */
interface PendingEffect {
  readonly v: 1;
  readonly state: 'blocked' | 'settled';
  readonly recoveryText: string;
}

interface StoredLifecycle {
  readonly version: 1 | 2;
  readonly history: readonly LifecycleEvent[];
  readonly platformMessageId?: string;
  /** v2 only: per-binding placeholder message ids when a thread has multiple bindings. */
  readonly platformMessageByKey?: Readonly<Record<string, string>>;
  readonly actorDisplayName: string;
  /** v2 only: last write time, drives stranded-record sweep TTL. */
  readonly updatedAt?: number;
  /** v2 tombstone only: compressed settled record with the minimum replay/reject identity. */
  readonly tombstone?: boolean;
  /** v2 tombstone only: every accepted deliveryId, so pre-settle redeliveries still answer replay. */
  readonly deliveryIds?: readonly string[];
  /** v2 tombstone only: when the lifecycle settled, drives tombstone sweep TTL. */
  readonly settledAt?: number;
  /** v2 only: recovery side effect accepted but not yet confirmed; a redelivery re-executes it. */
  readonly pendingEffect?: PendingEffect;
}

const STARTED_TEXT = '🤔 思考中...';
const CATCHING_UP_TEXT = '🔄 收到新消息，正在重新整理回复…';

const LIFECYCLE_KEY_PREFIX = 'lifecycle/';
// A settled tombstone only answers Host redeliveries with replay/reject; a
// day is far beyond any sane redelivery horizon, so keeping it longer only
// accumulates dead keys.
const LIFECYCLE_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;
// Records that never settled are Host-crash orphans: their placeholder text
// is already terminal. The TTL must exceed the longest legitimate in-flight
// turn (cat work can span many hours), so 24h bounds orphans without
// deleting lifecycles that are still actively running.
const LIFECYCLE_STRANDED_TTL_MS = 24 * 60 * 60 * 1000;
const SWEEP_EVERY_WRITES = 25;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPendingEffect(value: unknown): value is PendingEffect {
  return object(value)
    && value.v === 1
    && (value.state === 'blocked' || value.state === 'settled')
    && typeof value.recoveryText === 'string';
}

function lifecycleError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}

function storedLifecycle(value: unknown): StoredLifecycle {
  if (!object(value)
    || (value.version !== 1 && value.version !== 2)
    || !Array.isArray(value.history)
    || typeof value.actorDisplayName !== 'string'
    || (value.platformMessageId !== undefined && typeof value.platformMessageId !== 'string')
    || (value.platformMessageByKey !== undefined
      && (!object(value.platformMessageByKey) || Object.values(value.platformMessageByKey).some(id => typeof id !== 'string')))
    || (value.updatedAt !== undefined && typeof value.updatedAt !== 'number')
    || (value.tombstone !== undefined && typeof value.tombstone !== 'boolean')
    || (value.deliveryIds !== undefined && (!Array.isArray(value.deliveryIds) || value.deliveryIds.some(id => typeof id !== 'string')))
    || (value.settledAt !== undefined && typeof value.settledAt !== 'number')
    || (value.pendingEffect !== undefined && !isPendingEffect(value.pendingEffect))) {
    throw lifecycleError('PLUGIN_INTERNAL', 'stored lifecycle state is invalid');
  }
  return structuredClone(value) as unknown as StoredLifecycle;
}

function recoveryText(event: Extract<LifecycleEvent, { readonly state: 'blocked' }>): string {
  return `⚠️ 未能完成最新消息重读（${event.reason}）。请打开 Clowder AI 重试${event.recoveryUrl ? `：${event.recoveryUrl}` : '。'}`;
}

export function createConnectorLifecycleAction(
  context: FeatureContext,
  callbacks: ConnectorLifecycleCallbacks,
) {
  const tails = new Map<string, Promise<void>>();
  let writesSinceSweep = 0;
  let sweepInFlight = false;

  const sweep = async (): Promise<void> => {
    let listed: Readonly<Record<string, { readonly revision: number; readonly value: unknown }>>;
    try {
      listed = await context.storage.list();
    } catch (error) {
      context.log('warn', 'Connector lifecycle sweep failed', {
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      return;
    }
    const now = Date.now();
    for (const [key, item] of Object.entries(listed)) {
      if (!key.startsWith(LIFECYCLE_KEY_PREFIX)) continue;
      let record: StoredLifecycle;
      try {
        record = storedLifecycle(item?.value);
      } catch {
        continue;
      }
      if (record.tombstone === true) {
        const settledAt = record.settledAt ?? record.updatedAt;
        if (settledAt !== undefined && settledAt + LIFECYCLE_TOMBSTONE_TTL_MS < now) {
          await context.storage.delete(key, item.revision).catch(() => undefined);
        }
        continue;
      }
      // v1 records carry no updatedAt, so their age is unknown; the v2 write
      // path re-binds them with a timestamp on the next transition.
      if (record.updatedAt !== undefined && record.updatedAt + LIFECYCLE_STRANDED_TTL_MS < now) {
        await context.storage.delete(key, item.revision).catch(() => undefined);
      }
    }
  };

  // Single-flight background sweep, mirroring reply-sender-map: the hot path
  // only counts writes. console.warn (not context.log) is deliberate here —
  // log() throws FeatureContextRevokedError after feature shutdown, which
  // would turn this last-resort guard into an unhandled rejection.
  const sweepInBackground = (): void => {
    if (sweepInFlight) return;
    sweepInFlight = true;
    void sweep()
      .catch((error: unknown) => {
        console.warn('Connector lifecycle sweep failed', {
          errorName: error instanceof Error ? error.name : 'unknown',
        });
      })
      .finally(() => {
        sweepInFlight = false;
      });
  };

  const countWrite = (): void => {
    writesSinceSweep += 1;
    if (writesSinceSweep < SWEEP_EVERY_WRITES) return;
    writesSinceSweep = 0;
    sweepInBackground();
  };

  // Platform effects must not fail the action; the write-ahead record already
  // accepted the event, so a throwing callback is logged and skipped.
  const runEffectSafely = async (
    lifecycleId: string,
    state: string,
    label: string,
    effect: () => unknown | Promise<unknown>,
  ): Promise<boolean> => {
    try {
      await effect();
      return true;
    } catch (error) {
      context.log('warn', `Connector lifecycle ${label} failed`, {
        lifecycleId,
        state,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      return false;
    }
  };

  // Binding listing feeds every side-effect path; a failure here must
  // surface as a coded lifecycle error, not a bare storage/transport
  // exception escaping the action boundary.
  const listThreadBindings = async (threadId: string) => {
    let listed: Awaited<ReturnType<typeof context.threads.listBindings>>;
    try {
      listed = await context.threads.listBindings();
    } catch (error) {
      throw lifecycleError(
        'PLUGIN_INTERNAL',
        `lifecycle thread ${threadId} binding listing failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
    return listed.filter(candidate => candidate.threadId === threadId);
  };

  // A redelivery (or a later transition arriving first) can find a record
  // whose accepted side effect never ran because the process died between the
  // pre-write and the platform call. Re-run exactly that effect through the
  // same callbacks and per-binding fallbacks as the original path.
  //
  // The marker is cleared after the ATTEMPT, not after confirmed success:
  // runEffectSafely swallows per-binding failures (they are logged), and an
  // unbounded "retry until applied" loop would duplicate-send on every
  // redelivery. One bounded re-execution per redelivery beats both a lost
  // recovery hint and an effect storm.
  //
  // Returns whether the effect was actually attempted on at least one
  // binding. A thread with no matching binding is not an attempt: the caller
  // must keep the marker so a redelivery after the binding returns can still
  // recover the hint.
  const reexecutePendingEffect = async (stored: StoredLifecycle): Promise<boolean> => {
    const pending = stored.pendingEffect;
    if (pending === undefined) return false;
    const sourceEvent = [...stored.history].reverse().find(
      (candidate): candidate is Extract<LifecycleEvent, { readonly state: 'blocked' | 'settled' }> => (
        candidate.state === pending.state
      ),
    );
    if (sourceEvent === undefined) return false;
    const bindings = await listThreadBindings(sourceEvent.threadId);
    // Legacy records carry a single platformMessageId; with exactly one
    // matching binding it can only have belonged to that binding.
    let messageIds: Record<string, string> = { ...(stored.platformMessageByKey ?? {}) };
    if (Object.keys(messageIds).length === 0 && bindings.length === 1 && stored.platformMessageId !== undefined) {
      messageIds = { [bindings[0].key]: stored.platformMessageId };
    }
    for (const binding of bindings) {
      const platformMessageId = messageIds[binding.key];
      if (pending.state === 'blocked') {
        const edited = platformMessageId !== undefined && await runEffectSafely(
          sourceEvent.lifecycleId,
          'blocked',
          'blocked edit',
          async () => {
            const applied = await callbacks.editPlaceholder(
              binding.key,
              platformMessageId!,
              pending.recoveryText,
              'blocked',
              sourceEvent.lifecycleId,
            );
            if (!applied) throw new Error('placeholder is no longer editable');
          },
        );
        if (!edited) {
          await runEffectSafely(
            sourceEvent.lifecycleId,
            'blocked',
            'blocked recovery send',
            () => callbacks.sendRecovery(binding.key, pending.recoveryText),
          );
        }
      } else {
        await runEffectSafely(sourceEvent.lifecycleId, 'settled', 'settlement', () => callbacks.settle({
          externalConversationId: binding.key,
          ...(platformMessageId === undefined ? {} : { platformMessageId }),
          actorDisplayName: stored.actorDisplayName,
          recoveryText: pending.recoveryText,
          event: sourceEvent as SettledEvent,
        }));
      }
    }
    return bindings.length > 0;
  };

  const clearPendingEffect = async (stateKey: string, stored: StoredLifecycle): Promise<void> => {
    try {
      await context.storage.set(stateKey, { ...stored, pendingEffect: undefined });
      countWrite();
    } catch (error) {
      // The marker survives, so a further redelivery re-executes the effect
      // once more; losing the clear is duplicate-tolerant by design.
      context.log('warn', 'Connector lifecycle pending-effect clear failed', {
        errorName: error instanceof Error ? error.name : 'unknown',
      });
    }
  };

  const handle = async (event: LifecycleEvent) => {
    const stateKey = `lifecycle/${event.lifecycleId}`;
    const safely = (label: string, effect: () => unknown | Promise<unknown>): Promise<boolean> =>
      runEffectSafely(event.lifecycleId, event.state, label, effect);
    const entry = await context.storage.get(stateKey);
    const stored = entry === undefined ? undefined : storedLifecycle(entry.value);
    if (stored?.tombstone === true) {
      // The tombstone keeps the full event history, so redelivery judgment is
      // the same as the pre-settle path: an exact redelivery of anything the
      // Host already acked answers replay, the same deliveryId with different
      // content is a delivery conflict, and anything else is out of order.
      const tombstoneDecision = decideLifecycleTransition(stored.history, event);
      if (tombstoneDecision.kind === 'replay') {
        // Crash residue: the accepted side effect may never have run. Re-run
        // it once for this redelivery. The marker is cleared only when the
        // effect was actually attempted: with no binding there is nothing to
        // retry, and a later redelivery must still be able to recover the
        // hint (see reexecutePendingEffect for why not after success).
        if (stored.pendingEffect !== undefined && stored.pendingEffect.state === event.state) {
          if (await reexecutePendingEffect(stored)) {
            await clearPendingEffect(stateKey, stored);
          }
        }
        return { deliveryId: event.deliveryId };
      }
      if (tombstoneDecision.kind === 'reject' && tombstoneDecision.reason === 'DELIVERY_CONFLICT') {
        throw lifecycleError(lifecycleRejectReason(tombstoneDecision), `lifecycle ${tombstoneDecision.reason.toLowerCase()}`);
      }
      // Tombstones written before the full history was retained only know the
      // accepted deliveryId set; for them that set is the only replay identity.
      const deliveryIds = stored.deliveryIds ?? [];
      if (deliveryIds.includes(event.deliveryId)) {
        return { deliveryId: event.deliveryId };
      }
      throw lifecycleError('LIFECYCLE_OUT_OF_ORDER', 'lifecycle is already settled');
    }
    const history = stored?.history ?? [];
    const decision = decideLifecycleTransition(history, event);
    if (decision.kind === 'replay') {
      // Crash residue, pre-settle flavor: the blocked recovery effect was
      // accepted but may never have run. Re-run it once. The marker is
      // cleared only when the effect was actually attempted: with no binding
      // a later redelivery must still be able to recover the hint.
      if (stored?.pendingEffect !== undefined && stored.pendingEffect.state === event.state) {
        if (await reexecutePendingEffect(stored)) {
          await clearPendingEffect(stateKey, stored);
        }
      }
      return { deliveryId: event.deliveryId };
    }
    if (decision.kind === 'reject') {
      throw lifecycleError(lifecycleRejectReason(decision), `lifecycle ${decision.reason.toLowerCase()}`);
    }

    // A new transition arrives while an older one still has an unconfirmed
    // side effect (the crash window, or a lost post-write): this write would
    // overwrite the marker, so flush the pending effect first and clear the
    // marker. The marker is cleared only when the flush was actually
    // attempted on at least one binding: with no binding the flush is a
    // no-op and clearing here would lose the recovery hint for good once
    // the zero-binding throw below rejects this delivery. Without the clear,
    // a failed new pre-write would leave the old marker in place and every
    // Host retry of this delivery would re-run the already-flushed effect
    // again. An occasional duplicate beats a lost recovery hint.
    if (stored?.pendingEffect !== undefined) {
      if (await reexecutePendingEffect(stored)) {
        await clearPendingEffect(stateKey, stored);
      }
    }

    // One thread can carry several provider bindings (the Host allows
    // rebinding different external chats onto the same thread), so every
    // matching binding receives the outbound effects.
    const bindings = await listThreadBindings(event.threadId);
    if (bindings.length === 0) {
      throw lifecycleError('PLUGIN_INTERNAL', `lifecycle thread ${event.threadId} has no provider binding`);
    }

    const actorDisplayName = event.state === 'started'
      ? event.presentation.actor.displayName
      : stored?.actorDisplayName ?? '';

    // Per-binding placeholder message ids. Legacy records carry a single
    // platformMessageId; with exactly one matching binding it can only have
    // belonged to that binding.
    let messageIds: Record<string, string> = { ...(stored?.platformMessageByKey ?? {}) };
    if (Object.keys(messageIds).length === 0 && bindings.length === 1 && stored?.platformMessageId !== undefined) {
      messageIds = { [bindings[0].key]: stored.platformMessageId };
    }

    // Recovery text is decided up front: the blocked transition's hint, or
    // the retained blocked event's hint for a settled transition.
    const blocked = [...history].reverse().find((candidate): candidate is Extract<LifecycleEvent, { readonly state: 'blocked' }> => (
      candidate.state === 'blocked'
    ));
    // Transitions carrying a user-facing recovery side effect are marked
    // pending-effect in the pre-write; the post-write clears the marker once
    // the effect completed. Started placeholders stay at-most-once on
    // purpose — the final reply arrives separately — and catching_up edits
    // self-heal through the later blocked/settle effects.
    const pendingEffect: PendingEffect | undefined = event.state === 'blocked'
      ? { v: 1, state: 'blocked', recoveryText: recoveryText(event) }
      : event.state === 'settled' && blocked !== undefined
        ? { v: 1, state: 'settled', recoveryText: recoveryText(blocked) }
        : undefined;

    // Settled records compress into a tombstone: platform effects stop, but
    // the full event history is retained so redelivery judgment can still
    // distinguish an exact replay from a same-deliveryId content conflict.
    const nextRecord = (ids: Record<string, string>, pending?: PendingEffect): StoredLifecycle => ({
      version: 2,
      history: [...history, event],
      // Keep the legacy single-id field only when it is unambiguous.
      ...(Object.keys(ids).length === 1 ? { platformMessageId: Object.values(ids)[0] } : {}),
      ...(Object.keys(ids).length === 0 ? {} : { platformMessageByKey: ids }),
      actorDisplayName,
      updatedAt: Date.now(),
      ...(pending !== undefined ? { pendingEffect: pending } : {}),
      ...(event.state === 'settled'
        ? { tombstone: true, deliveryIds: [...history.map(candidate => candidate.deliveryId), event.deliveryId], settledAt: Date.now() }
        : {}),
    });

    // Write-ahead: persist the accepted event before any platform side
    // effect, so a crash between effect and store cannot leave later events
    // orphaned as OUT_OF_ORDER. The pre-write carries the pending-effect
    // marker, so a redelivery that finds it re-runs the unconfirmed effect.
    // If even the identical retry fails we throw before any side effect: no
    // half-persisted record, no duplicate sends.
    const preWrite = nextRecord(messageIds, pendingEffect);
    try {
      await context.storage.set(stateKey, preWrite);
      countWrite();
    } catch {
      try {
        await context.storage.set(stateKey, preWrite);
        countWrite();
      } catch (error) {
        throw lifecycleError(
          'PLUGIN_INTERNAL',
          `lifecycle ${event.lifecycleId} state pre-write failed: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      }
    }

    // Resolve the sender name once, outside the per-binding loop: it only
    // depends on event.replyTo, never on the binding, so N bindings must not
    // trigger N lookups. Resolve before the safely() wrapper: a throwing
    // callback must not take down the whole placeholder send. resolve() in
    // reply-sender-map already swallows storage errors; this catch covers
    // every other failure reason.
    let senderName: string | undefined;
    if (event.state === 'started' && event.replyTo !== undefined && callbacks.resolveReplySenderName !== undefined) {
      try {
        senderName = await callbacks.resolveReplySenderName(event.replyTo);
      } catch (error) {
        context.log('warn', 'Connector lifecycle sender name resolution failed', {
          lifecycleId: event.lifecycleId,
          errorName: error instanceof Error ? error.name : 'unknown',
        });
        senderName = undefined;
      }
    }
    const senderSuffix = senderName ? `→${senderName}` : '';

    for (const binding of bindings) {
      let platformMessageId: string | undefined = messageIds[binding.key];
      switch (event.state) {
      case 'started':
        await safely('placeholder send', async () => {
          const displayName = actorDisplayName || '猫猫';
          const placeholderLine = event.placeholderLine ?? STARTED_TEXT;
          const candidate = await callbacks.sendPlaceholder(
            binding.key,
            `【${displayName}🐱${senderSuffix}】${placeholderLine}`,
          );
          platformMessageId = candidate.length > 0 ? candidate : undefined;
          if (platformMessageId !== undefined) {
            await callbacks.onPlaceholder?.(binding.key, platformMessageId, event.lifecycleId);
          }
        });
        break;
      case 'catching_up':
        if (platformMessageId !== undefined) {
          await safely('catching-up edit', () => callbacks.editPlaceholder(
            binding.key,
            platformMessageId!,
            CATCHING_UP_TEXT,
            'catching_up',
            event.lifecycleId,
          ));
        }
        break;
      case 'blocked':
        {
          const text = recoveryText(event);
          const edited = platformMessageId !== undefined && await safely('blocked edit', async () => {
            const applied = await callbacks.editPlaceholder(
              binding.key,
              platformMessageId!,
              text,
              'blocked',
              event.lifecycleId,
            );
            if (!applied) throw new Error('placeholder is no longer editable');
          });
          if (!edited) {
            await safely('blocked recovery send', () => callbacks.sendRecovery(binding.key, text));
          }
        }
        break;
      case 'settled': {
        await safely('settlement', () => callbacks.settle({
          externalConversationId: binding.key,
          ...(platformMessageId === undefined ? {} : { platformMessageId }),
          actorDisplayName,
          ...(blocked === undefined ? {} : { recoveryText: recoveryText(blocked) }),
          event,
        }));
        break;
      }
      }
      if (platformMessageId === undefined) delete messageIds[binding.key];
      else messageIds[binding.key] = platformMessageId;
    }

    try {
      await context.storage.set(stateKey, nextRecord(messageIds));
      countWrite();
    } catch (error) {
      // Post-write failure is warn-only: the event already sits in history
      // via the write-ahead, so a Host replay of this delivery is answered
      // as replay and never re-runs the platform side effects. The recovery
      // effect is the exception: its marker survives until a redelivery
      // re-executes it, so a lost post-write there is duplicate-tolerant
      // rather than losing the hint. The only other loss is the fresh
      // platformMessageId, covered by the existing
      // undefined-platformMessageId fallback for later edits.
      context.log('warn', 'Connector lifecycle state post-write failed', {
        lifecycleId: event.lifecycleId,
        state: event.state,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
    }
    return { deliveryId: event.deliveryId };
  };

  const action = defineLifecycleAction(async (event) => {
    const previous = tails.get(event.lifecycleId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => handle(event));
    const tail = current.then(() => undefined, () => undefined);
    tails.set(event.lifecycleId, tail);
    try {
      return await current;
    } finally {
      if (tails.get(event.lifecycleId) === tail) tails.delete(event.lifecycleId);
    }
  });
  // Test/debug hook: force the background sweep synchronously.
  return Object.assign(action, { sweepNow: sweep });
}
