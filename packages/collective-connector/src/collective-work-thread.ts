import { threadMappings } from './thread-mappings.js';
import type { PluginMessage, PluginTaskReadItem, PluginTaskHost, PluginThreadHost, PluginStorageHost } from "@clowder-ai/plugin-sdk";

type Source = Pick<PluginMessage, "id" | "userId" | "threadId" | "content">;
type Work = Pick<PluginTaskReadItem, "userId" | "ownerCatId" | "threadId" | "entrustedWork">;

/** The original Collective source/cat site policy, separated from neutral Host
 * ownership, parent inheritance and canonical thread creation. This detached plan
 * grants nothing; an authenticated caller must consume it through the Host.
 * The caller supplies authenticated source facts; body fields grant nothing. */
export function selectCollectiveWorkThread(tasks: readonly Work[], source: Source, catId: string) {
  const matches = tasks.filter(
    (task) =>
      task.userId === source.userId &&
      task.ownerCatId === catId &&
      task.entrustedWork?.admission.sourceRefs.includes(`message:${source.id}`),
  );
  if (matches.length > 1)
    throw Object.assign(new Error("Source resolves to multiple existing Works"), { code: "WORK_SOURCE_AMBIGUOUS" });
  if (matches[0]) return Object.freeze({ kind: "existing" as const, threadId: matches[0].threadId });
  return Object.freeze({
    kind: "ensure" as const,
    key: `collective-work:${source.id}:${catId}`,
    input: Object.freeze({
      title: source.content.slice(0, 160),
      participants: Object.freeze([catId]),
      parentThreadId: source.threadId,
    }),
  });
}

/** Resolve the existing Work or save a plugin-owned mapping after ordinary
 * Host get/create calls. Host validates resources, parent/project inheritance
 * and participants. This function neither admits a Task nor chooses business basis. */
export async function resolveCollectiveWorkThread(
  threads: Pick<PluginThreadHost, "get" | "create">,
  tasks: Pick<PluginTaskHost, "list">,
  source: Source,
  catId: string,
  storage: Pick<PluginStorageHost, "get" | "compareAndSet">,
) {
  const site = selectCollectiveWorkThread(await tasks.list({ kind: "work" }), source, catId);
  if (site.kind === "existing") {
    const owned = await threads.get(site.threadId);
    if (!owned)
      throw Object.assign(new Error("The owned execution Thread is unavailable"), {
        code: "OWNER_ADMISSION_UNAVAILABLE",
      });
    return owned.id;
  }
  return (await threadMappings({ threads, storage } as import('@clowder-ai/plugin-sdk').FeatureContext).ensureByKey(site.key, site.input)).id;
}
