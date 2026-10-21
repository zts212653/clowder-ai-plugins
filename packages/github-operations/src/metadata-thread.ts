import type { PluginThreadHost, PluginThreadSummary } from '@clowder-ai/plugin-sdk';

/** Resolve an owner-visible summary through metadata grants; never request thread contents. */
export async function findThreadMetadata(threads: Pick<PluginThreadHost, 'list'>,
  id: string): Promise<PluginThreadSummary | null> {
  let before: { lastActiveAt: number; id: string } | undefined;
  for (;;) {
    const page = await threads.list({ limit: 50, ...(before ? { before } : {}) });
    const found = page.find(thread => thread.id === id);
    if (found) return found;
    if (page.length < 50) {
      // Only one atomic page can establish absence. Across live pages the
      // target may have moved ahead of an earlier cursor; callers must not
      // replace a durable mapping or create a thread from that uncertainty.
      if (before) throw new Error('Cannot confirm thread metadata from a live paginated listing');
      return null;
    }
    const last = page.at(-1)!;
    before = { lastActiveAt: last.lastActiveAt, id: last.id };
  }
}
