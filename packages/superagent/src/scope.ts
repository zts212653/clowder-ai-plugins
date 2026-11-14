import type { SuperagentHost } from './runtime.js';
import { type Preferences, read, records, runtimeSchema, workSchema } from './state.js';

export async function watchScope(host: SuperagentHost, pref: Preferences) {
  const automatic: string[] = [];
  if ((await host.config.get('watchPinned')) !== false) {
    // Local Host extension: the published SDK forwards list options unchanged.
    // Only the Host can select the owner's current pins, including older pages.
    let before: { lastActiveAt: number; id: string } | undefined;
    while (true) {
      const options = { pinnedOnly: true, limit: 50, ...(before ? { before } : {}) };
      const page = await host.threads.list(options);
      automatic.push(...page.map((thread) => thread.id));
      if (page.length < 50) break;
      const last = page.at(-1)!;
      before = { lastActiveAt: last.lastActiveAt, id: last.id };
    }
  }
  const runtime = await read(host, 'runtime', runtimeSchema);
  const works = await records(host, 'work:', workSchema);
  const excluded = new Set(['default', runtime?.mainThreadId, runtime?.coordinationThreadId, ...works.map((work) => work.threadId)]);
  const pinned = automatic.filter((id) => !excluded.has(id));
  return { automatic: pinned, threadIds: [...new Set([...pref.threadIds, ...pinned])].filter((id) => !excluded.has(id)) };
}
