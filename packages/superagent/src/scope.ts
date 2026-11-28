import type { SuperagentHost } from './runtime.js';
import { type Preferences, read, records, runtimeSchema, workSchema } from './state.js';

export async function watchScope(host: SuperagentHost, pref: Preferences) {
  const [runtime, works] = await Promise.all([
    read(host, 'runtime', runtimeSchema),
    records(host, 'work:', workSchema),
  ]);
  const excluded = new Set(['default', runtime?.mainThreadId, runtime?.coordinationThreadId, ...works.map((work) => work.threadId)]);
  return { threadIds: [...new Set(pref.threadIds)].filter((id) => !excluded.has(id)) };
}
