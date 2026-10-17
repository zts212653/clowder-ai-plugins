import type { PluginSourceFact, PluginTaskReadItem, PluginTaskHost, PluginThreadHost } from "@clowder-ai/plugin-sdk";

type Source = Pick<PluginSourceFact, "id" | "userId" | "threadId" | "content">;
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

/** Consume the original policy using the approved neutral owner-filtered ports.
 * Host get/ensure own visibility, canonical child, parent/project inheritance and
 * participants. This function neither admits a Task nor chooses business basis. */
export async function resolveCollectiveWorkThread(
  threads: Pick<PluginThreadHost, "get" | "ensureByKey">,
  tasks: Pick<PluginTaskHost, "listByKind">,
  source: Source,
  catId: string,
) {
  const site = selectCollectiveWorkThread(await tasks.listByKind("work"), source, catId);
  if (site.kind === "existing") {
    const owned = await threads.get(site.threadId);
    if (!owned)
      throw Object.assign(new Error("The owned execution Thread is unavailable"), {
        code: "OWNER_ADMISSION_UNAVAILABLE",
      });
    return owned.id;
  }
  return (await threads.ensureByKey(site.key, site.input)).id;
}
