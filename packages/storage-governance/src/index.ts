import { readFile } from 'node:fs/promises';
import { scanStorage, summarize, type Sources } from './scan.js';

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
  conversationStorage?: {
    startRead(): Promise<Sources>;
    beginRead?(): Promise<void>;
    getRead?(): Promise<ReadState>;
  };
}

type State =
  | { state: 'running' }
  | { state: 'ready'; result: Awaited<ReturnType<typeof scanStorage>> }
  | { state: 'error'; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function json(status: number, payload: object) {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    body: JSON.stringify(payload) };
}

function pageOf(state: Extract<State, { state: 'ready' }>, raw: Record<string, unknown>) {
  const str = (key: string) => (typeof raw[key] === 'string' ? raw[key].trim() : '');
  const offset = Number(str('offset') || '0');
  const limit = Number(str('limit') || '100');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    return json(400, { error: 'invalid-page' });
  const volume = str('volume').toUpperCase();
  const threadId = str('threadId');
  const category = str('category');
  const term = str('query').toLowerCase();
  const { files, omissions, ...report } = state.result;
  const filtered = volume || threadId || category || term;
  const matches = filtered
    ? files.filter((row) => (!volume || row.volume.toUpperCase() === volume)
      && (!threadId || (threadId === '__unknown__' ? !row.threadIds.length : row.threadIds.includes(threadId)))
      && (!category || row.category === category)
      && (!term || row.path.toLowerCase().includes(term)))
    : files;
  return json(200, {
    state: 'ready', ...report, omissions: omissions.slice(0, 100), omissionCount: omissions.length,
    ...(filtered ? { selection: summarize(matches) } : {}),
    files: matches.slice(offset, offset + limit), total: matches.length,
    ...(offset + limit < matches.length ? { nextOffset: offset + limit } : {}),
  });
}

export default {
  create() {
    return {
      start(host: Host) {
        const controller = new AbortController();
        const scans = new Map<string, State>();
        const readStages = new Map<string, 'sources' | 'scan'>();
        const polling = new Set<string>();
        const sources = host.conversationStorage;
        const finishScan = (userId: string, input: Sources) => {
          void scanStorage(input, controller.signal).then(
            (result) => {
              if (!controller.signal.aborted) {
                readStages.delete(userId);
                scans.set(userId, { state: 'ready', result });
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
          const state = scans.get(owner.userId);
          if (!sources) return json(200, { state: 'error', error: 'host-capability-unavailable' });
          const body = isRecord(input.request.body) ? input.request.body : {};
          const postQuery = isRecord(body.query) ? body.query : undefined;
          if (method === 'POST' && postQuery) {
            if (state?.state !== 'ready') return json(200, state ?? { state: 'idle' });
            return pageOf(state, postQuery);
          }

          if (method === 'POST') {
            if (state?.state === 'running') return json(200, state);
            scans.set(owner.userId, { state: 'running' });
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
              return json(200, failed?.state === 'error' ? failed : { state: 'running' });
            }
            try {
              finishScan(owner.userId, await sources.startRead());
            } catch {
              scans.set(owner.userId, { state: 'error', error: 'sources-unavailable' });
            }
            return json(200, scans.get(owner.userId) ?? { state: 'idle' });
          }

          if (state?.state === 'running' && readStages.get(owner.userId) === 'sources') {
            if (polling.has(owner.userId)) return json(200, { state: 'running' });
            polling.add(owner.userId);
            let next: ReadState;
            try {
              next = await sources.getRead!();
            } catch {
              polling.delete(owner.userId);
              readStages.delete(owner.userId);
              if (!controller.signal.aborted) scans.set(owner.userId, { state: 'error', error: 'sources-unavailable' });
              return json(200, controller.signal.aborted ? { state: 'idle' } : { state: 'error', error: 'sources-unavailable' });
            }
            polling.delete(owner.userId);
            if (controller.signal.aborted) return json(200, { state: 'idle' });
            if (next.state === 'running') return json(200, { state: 'running' });
            if (next.state === 'idle') {
              readStages.delete(owner.userId);
              scans.delete(owner.userId);
              return json(200, { state: 'idle' });
            }
            if (next.state === 'error') {
              readStages.delete(owner.userId);
              scans.set(owner.userId, { state: 'error', error: 'sources-unavailable' });
              return json(200, { state: 'error', error: 'sources-unavailable' });
            }
            readStages.set(owner.userId, 'scan');
            finishScan(owner.userId, next.sources);
            return json(200, { state: 'running' });
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
            polling.clear();
          },
        };
      },
    };
  },
};
