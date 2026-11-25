import { readFile } from 'node:fs/promises';
import { scanStorage, summarize, type Sources } from './scan.js';

interface OwnerContext {
  kind: 'owner-http-request';
  userId: string;
  pluginInstanceId: string;
  operation: 'read' | 'write';
  assertCurrent(): Promise<void>;
}

interface Host {
  pluginInstanceId: string;
  conversationStorage?: {
    startRead(): Promise<Sources>;
    beginRead?(signal: AbortSignal): Promise<{ sources: Promise<Sources> }>;
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

export default {
  create() {
    return {
      start(host: Host) {
        const controller = new AbortController();
        const scans = new Map<string, State>();
        const sources = host.conversationStorage;
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

          if (method === 'POST') {
            if (state?.state === 'running') return json(200, state);
            scans.set(owner.userId, { state: 'running' });
            const finishScan = (input: Sources) => {
              void scanStorage(input, controller.signal).then(
                (result) => {
                  if (!controller.signal.aborted) scans.set(owner.userId, { state: 'ready', result });
                },
                () => {
                  if (!controller.signal.aborted) scans.set(owner.userId, { state: 'error', error: 'scan-failed' });
                },
              );
            };
            if (sources.beginRead) {
              let accepted = false;
              try {
                const handle = await sources.beginRead(controller.signal);
                accepted = true;
                void handle.sources.then(
                  (input) => {
                    if (!controller.signal.aborted) finishScan(input);
                  },
                  () => {
                    if (!controller.signal.aborted)
                      scans.set(owner.userId, { state: 'error', error: 'sources-unavailable' });
                  },
                );
              } catch {
                if (!controller.signal.aborted)
                  scans.set(owner.userId, { state: 'error', error: 'sources-unavailable' });
              }
              // The handle is the contract: sources continue in the background and
              // the page polls GET /scan. Never block the POST on source discovery.
              return json(200, accepted ? { state: 'running' } : (scans.get(owner.userId) ?? { state: 'running' }));
            }
            try {
              finishScan(await sources.startRead());
            } catch {
              scans.set(owner.userId, { state: 'error', error: 'sources-unavailable' });
            }
            return json(200, scans.get(owner.userId) ?? { state: 'idle' });
          }

          if (state?.state !== 'ready') return json(200, state ?? { state: 'idle' });
          const raw = isRecord(query) ? query : {};
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
        async function panel(_input: unknown, _native?: unknown, owner?: OwnerContext) {
          if (owner?.kind !== 'owner-http-request' || owner.pluginInstanceId !== host.pluginInstanceId)
            return json(403, { error: 'owner-required' });
          await owner.assertCurrent();
          const body = await readFile(new URL('./page.html', import.meta.url), 'utf8');
          return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body };
        }
        return {
          actions: { 'storage-governance.scan': action, 'storage-governance.panel': panel },
          stop() {
            controller.abort();
            scans.clear();
          },
        };
      },
    };
  },
};
