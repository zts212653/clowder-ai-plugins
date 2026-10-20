import type { FeatureContext } from '@clowder-ai/plugin-sdk';

export interface ReplySender {
  readonly id: string;
  readonly name?: string;
}

interface ReplySenderEntry {
  readonly version: 1;
  readonly sender: ReplySender;
  readonly storedAt: number;
}

const KEY_PREFIX = 'reply-sender:';
const ENTRY_TTL_MS = 24 * 60 * 60 * 1000;
const SWEEP_EVERY_RECORDS = 50;
const ENTRY_CAP = 2000;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

function parseEntry(value: unknown): ReplySenderEntry | undefined {
  if (typeof value !== 'string') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!object(parsed) || parsed.version !== 1 || typeof parsed.storedAt !== 'number') return undefined;
  const candidate = parsed.sender;
  if (!object(candidate) || typeof candidate.id !== 'string' || candidate.id.length === 0) return undefined;
  return {
    version: 1,
    storedAt: parsed.storedAt,
    sender: {
      id: candidate.id,
      ...(typeof candidate.name === 'string' ? { name: candidate.name } : {}),
    },
  };
}

export function createReplySenderMap(context: FeatureContext) {
  let recordedSinceSweep = 0;
  let sweepInFlight = false;

  const sweep = async (): Promise<void> => {
    let listed: Readonly<Record<string, { readonly value: unknown }>>;
    try {
      listed = await context.storage.list();
    } catch (error) {
      context.log('warn', 'Connector reply-sender mapping sweep failed', { errorName: errorName(error) });
      return;
    }
    const now = Date.now();
    const live: Array<{ key: string; storedAt: number }> = [];
    for (const [key, item] of Object.entries(listed)) {
      if (!key.startsWith(KEY_PREFIX)) continue;
      const entry = parseEntry(item?.value);
      if (entry === undefined || entry.storedAt + ENTRY_TTL_MS < now) {
        await context.storage.delete(key).catch(() => undefined);
        continue;
      }
      live.push({ key, storedAt: entry.storedAt });
    }
    live.sort((a, b) => a.storedAt - b.storedAt);
    let overflow = live.length - (ENTRY_CAP - 1);
    for (let index = 0; overflow > 0 && index < live.length; index += 1, overflow -= 1) {
      await context.storage.delete(live[index].key).catch(() => undefined);
    }
  };

  // Sweep single-flight in the background: recording stays on the inbound
  // hot path and overlapping bursts never stack sweeps. sweep() already
  // swallows and logs its own storage failures. context.log is intentionally
  // NOT used here: log() runs assertActive() and throws
  // FeatureContextRevokedError after stop/revoke, so a sweep racing feature
  // shutdown would turn into an unhandled rejection; console.warn is the
  // reviewer-sanctioned exception that stays callable past revocation.
  const sweepInBackground = (): void => {
    if (sweepInFlight) return;
    sweepInFlight = true;
    void sweep()
      .catch((error: unknown) => {
        console.warn('Connector reply-sender mapping sweep failed', { errorName: errorName(error) });
      })
      .finally(() => {
        sweepInFlight = false;
      });
  };

  return {
    async record(hostMessageId: string, replySender: ReplySender): Promise<void> {
      const now = Date.now();
      try {
        await context.storage.set(
          `${KEY_PREFIX}${hostMessageId}`,
          JSON.stringify({ version: 1, sender: replySender, storedAt: now }),
        );
      } catch (error) {
        context.log('warn', 'Connector reply-sender mapping record failed', { errorName: errorName(error) });
        return;
      }
      recordedSinceSweep += 1;
      if (recordedSinceSweep < SWEEP_EVERY_RECORDS) return;
      recordedSinceSweep = 0;
      sweepInBackground();
    },
    async resolve(hostMessageId: string | undefined): Promise<ReplySender | undefined> {
      if (hostMessageId === undefined) return undefined;
      const key = `${KEY_PREFIX}${hostMessageId}`;
      let stored: { readonly value: unknown } | undefined;
      try {
        stored = await context.storage.get(key);
      } catch (error) {
        context.log('warn', 'Connector reply-sender mapping lookup failed', { errorName: errorName(error) });
        return undefined;
      }
      const entry = parseEntry(stored?.value);
      if (entry === undefined) return undefined;
      if (entry.storedAt + ENTRY_TTL_MS < Date.now()) {
        await context.storage.delete(key).catch(() => undefined);
        return undefined;
      }
      return entry.sender;
    },
  };
}
