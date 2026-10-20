import type { FeatureContext } from '@clowder-ai/plugin-sdk';
/** Compose standard thread metadata and actual thread participants; no separate ownership directory. */
export async function readCollectiveThread(threads: Pick<FeatureContext['threads'], 'get' | 'getCats'>, id: string) {
  const thread = await threads.get(id);
  if (!thread) return null;
  const cats = await threads.getCats(id);
  return { ...thread, participants: cats.participants.map(cat => cat.catId) };
}
