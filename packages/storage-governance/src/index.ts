import { readFile } from 'node:fs/promises';
import { indexStorage, pageStorage } from './pages.js';
import { scanStorage, type Sources, type StorageProgress } from './scan.js';

interface OwnerContext {
  kind: 'owner-http-request';
  userId: string;
  pluginInstanceId: string;
  operation: 'read' | 'write';
  assertCurrent(): Promise<void>;
}

type ReadState =
  | { state: 'running' }
  | { state: 'idle' }
  | { state: 'error' }
  | { state: 'ready'; sources: Sources };

interface Host {
  pluginInstanceId: string;
  storage?: {
    get(key: string): Promise<{ revision: number; value: unknown } | undefined>;
    compareAndSet(key: string, expected: number | null, value: unknown): Promise<{ applied: boolean }>;
  };
  conversationStorage?: {
    startRead(): Promise<Sources>;
    beginRead?(): Promise<void>;
    getRead?(): Promise<ReadState>;
  };
}

type RunningScan = {
  state: 'running';
  startedAt: number;
  previousDurationMs?: number;
  progress: Omit<StorageProgress, 'phase'> & { phase: StorageProgress['phase'] | 'preparing' };
};
type State =
  | RunningScan
  | { state: 'ready'; index: ReturnType<typeof indexStorage> }
  | { state: 'error'; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function json(status: number, payload: object) {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    body: JSON.stringify(payload) };
}

function pageOf(state: Extract<State, { state: 'ready' }>, raw: Record<string, unknown>) {
  const page = pageStorage(state.index, raw);
  return page ? json(200, page) : json(400, { error: 'invalid-page' });
}

export default {
  create() {
    return {
      start(host: Host) {
        const controller = new AbortController();
        const scans = new Map<string, State>();
        const previousDurations = new Map<string, number>();
        const durationKey = (userId: string) => 'last-scan-duration:' + userId;
        async function saveDuration(userId: string, duration: number) {
          previousDurations.set(userId, duration);
          const stored = await host.storage?.get(durationKey(userId));
          await host.storage?.compareAndSet(durationKey(userId), stored?.revision ?? null, duration);
        }
        const readStages = new Map<string, 'sources' | 'scan'>();
        const polling = new Set<string>();
        const sources = host.conversationStorage;
        const finishScan = (userId: string, input: Sources) => {
          const running = scans.get(userId);
          if (running?.state !== 'running') return;
          void scanStorage(input, controller.signal, (progress) => {
            running.progress = progress;
          }).then(indexStorage).then(
            async (index) => {
              if (!controller.signal.aborted) {
                readStages.delete(userId);
                await saveDuration(userId, Math.max(1, Date.now() - running.startedAt)).catch(() => undefined);
                if (!controller.signal.aborted) scans.set(userId, { state: 'ready', index });
              }
            },
            () => {
              if (!controller.signal.aborted) {
                readStages.delete(userId);
                scans.set(userId, { state: 'error', error: 'scan-failed' });
              }
            },
          );
        };
        async function action(input: unknown, _native?: unknown, owner?: OwnerContext) {
          if (owner?.kind !== 'owner-http-request' || owner.pluginInstanceId !== host.pluginInstanceId)
            return json(403, { error: 'owner-required' });
          if (!isRecord(input) || !isRecord(input.request)) return json(400, { error: 'invalid-request' });
          const { method, query } = input.request;
          if (method !== 'GET' && method !== 'POST') return json(405, { error: 'invalid-method' });
          if (owner.operation !== (method === 'GET' ? 'read' : 'write')) return json(403, { error: 'owner-required' });
          await owner.assertCurrent();
          let state = scans.get(owner.userId);
          const statusOnly = method === 'GET' && isRecord(query) && query.view === 'status';
          if (!sources)
            return json(200, statusOnly ? { activity: null } : { state: 'error', error: 'host-capability-unavailable' });
          const body = isRecord(input.request.body) ? input.request.body : {};
          const postQuery = isRecord(body.query) ? body.query : undefined;
          if (method === 'POST' && postQuery) {
            if (state?.state !== 'ready') return json(200, state ?? { state: 'idle' });
            return pageOf(state, postQuery);
          }

          if (method === 'POST') {
            if (state?.state === 'running') return json(200, state);
            const running: RunningScan = {
              state: 'running', startedAt: Date.now(), previousDurationMs: previousDurations.get(owner.userId),
              progress: { phase: 'preparing', rootsDone: 0, rootsTotal: 0, filesSeen: 0 },
            };
            scans.set(owner.userId, running);
            if (running.previousDurationMs === undefined && host.storage) {
              const stored = await host.storage.get(durationKey(owner.userId)).catch(() => undefined);
              const value = stored?.value;
              if (typeof value === 'number' && Number.isFinite(value) && value > 0)
                running.previousDurationMs = value;
              if (controller.signal.aborted) return json(200, { state: 'idle' });
            }
            if (sources.beginRead && sources.getRead) {
              readStages.set(owner.userId, 'sources');
              try {
                // Worker RPC: only invoke the no-arg starter here. Source state is
                // plain data and is polled through getRead on authenticated GETs.
                await sources.beginRead();
              } catch {
                if (!controller.signal.aborted) {
                  readStages.delete(owner.userId);
                  scans.set(owner.userId, { state: 'error', error: 'sources-unavailable' });
                }
              }
              if (controller.signal.aborted) return json(200, { state: 'idle' });
              const failed = scans.get(owner.userId);
              return json(200, failed?.state === 'error' ? failed : running);
            }
            try {
              finishScan(owner.userId, await sources.startRead());
            } catch {
              scans.set(owner.userId, { state: 'error', error: 'sources-unavailable' });
            }
            return json(200, scans.get(owner.userId) ?? { state: 'idle' });
          }

          if (state?.state === 'running' && readStages.get(owner.userId) === 'sources' && !polling.has(owner.userId)) {
            polling.add(owner.userId);
            const next = await Promise.resolve()
              .then(() => sources.getRead!())
              .catch(() => ({ state: 'error' as const }));
            polling.delete(owner.userId);
            if (controller.signal.aborted) {
              state = undefined;
            } else if (next.state === 'ready') {
              readStages.set(owner.userId, 'scan');
              finishScan(owner.userId, next.sources);
            } else if (next.state === 'idle') {
              readStages.delete(owner.userId);
              scans.delete(owner.userId);
              state = undefined;
            } else if (next.state === 'error') {
              readStages.delete(owner.userId);
              state = { state: 'error', error: 'sources-unavailable' };
              scans.set(owner.userId, state);
            }
          }

          if (statusOnly) {
            const activity =
              state?.state === 'running' ? { kind: 'busy', label: '正在扫描' }
                : state?.state === 'ready' ? { kind: 'unread', label: '扫描完成' }
                  : null;
            return json(200, { activity });
          }

          if (state?.state !== 'ready') return json(200, state ?? { state: 'idle' });
          return pageOf(state, isRecord(query) ? query : {});
        }
        async function panel(_input: unknown, _native?: unknown, owner?: OwnerContext) {
          if (owner?.kind !== 'owner-http-request' || owner.pluginInstanceId !== host.pluginInstanceId)
            return json(403, { error: 'owner-required' });
          await owner.assertCurrent();
          const body = await readFile(new URL('./page.html', import.meta.url), 'utf8');
          return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body };
        }
        return {
          actions: {
            'storage-governance.scan': action,
            'storage-governance.panel': panel,
          },
          stop() {
            controller.abort();
            scans.clear();
            readStages.clear();
            previousDurations.clear();
            polling.clear();
          },
        };
      },
    };
  },
};
