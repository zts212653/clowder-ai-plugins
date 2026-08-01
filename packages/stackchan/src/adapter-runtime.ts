import type { CatCafeLimbClient } from './cat-cafe-client.js';
import type { StackChanJsonlEventSource } from './event-source.js';
import type { StackChanRemoteLimbServer } from './limb-server.js';

const DEFAULT_CYCLE_INTERVAL_MS = 1_000;

export interface StackChanAdapterCycleResult {
  readonly status: 'pending' | 'approved' | 'rejected';
  readonly events: number;
}

export interface StackChanAdapterRuntimeOptions {
  readonly client: CatCafeLimbClient;
  readonly eventSource: StackChanJsonlEventSource;
  readonly createServer: (apiKey: string) => StackChanRemoteLimbServer;
  readonly cycleIntervalMs?: number;
  readonly onError?: (error: Error) => void;
  readonly schedule?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  readonly cancelSchedule?: (timer: NodeJS.Timeout) => void;
}

export interface StackChanAdapterRuntime {
  start(): Promise<void>;
  runOnce(): Promise<StackChanAdapterCycleResult>;
  stop(): Promise<void>;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function createStackChanAdapterRuntime(
  options: StackChanAdapterRuntimeOptions,
): StackChanAdapterRuntime {
  const cycleIntervalMs = options.cycleIntervalMs ?? DEFAULT_CYCLE_INTERVAL_MS;
  if (
    !Number.isSafeInteger(cycleIntervalMs) ||
    cycleIntervalMs < 100 ||
    cycleIntervalMs > 60_000
  ) {
    throw new TypeError('Invalid StackChan adapter cycle interval');
  }
  const schedule = options.schedule ?? setTimeout;
  const cancelSchedule = options.cancelSchedule ?? clearTimeout;

  let running = false;
  let timer: NodeJS.Timeout | undefined;
  let cycle: Promise<StackChanAdapterCycleResult> | undefined;
  let server: StackChanRemoteLimbServer | undefined;
  let serverApiKey: string | undefined;
  let approved = false;

  async function ensureServer(apiKey: string): Promise<void> {
    if (server && serverApiKey === apiKey) return;
    if (server) await server.stop();
    server = options.createServer(apiKey);
    await server.start();
    serverApiKey = apiKey;
  }

  async function performCycle(): Promise<StackChanAdapterCycleResult> {
    const registration = await options.client.register();
    await ensureServer(registration.apiKey);
    approved = registration.status === 'approved';
    if (!approved) {
      return { status: registration.status, events: 0 };
    }
    await options.client.heartbeat();
    return {
      status: 'approved',
      events: await options.eventSource.pollOnce(),
    };
  }

  function scheduleNext(): void {
    if (!running || timer !== undefined) return;
    timer = schedule(() => {
      timer = undefined;
      void runtime.runOnce().catch(() => undefined).finally(scheduleNext);
    }, cycleIntervalMs);
  }

  const runtime: StackChanAdapterRuntime = {
    async start(): Promise<void> {
      if (running) return;
      running = true;
      try {
        await runtime.runOnce();
      } finally {
        scheduleNext();
      }
    },

    runOnce(): Promise<StackChanAdapterCycleResult> {
      if (cycle) return cycle;
      cycle = performCycle()
        .catch((error: unknown) => {
          const normalized = asError(error);
          options.onError?.(normalized);
          throw normalized;
        })
        .finally(() => {
          cycle = undefined;
        });
      return cycle;
    },

    async stop(): Promise<void> {
      running = false;
      if (timer) {
        cancelSchedule(timer);
        timer = undefined;
      }
      await cycle?.catch(() => undefined);
      if (approved) {
        await options.client.deregister().catch((error: unknown) => {
          options.onError?.(asError(error));
        });
      }
      approved = false;
      if (server) {
        await server.stop();
        server = undefined;
        serverApiKey = undefined;
      }
    },
  };

  return runtime;
}
