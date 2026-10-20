import type { FeatureContext } from '@clowder-ai/plugin-sdk';
type Mapping = { readonly key: string; readonly threadId: string; readonly createdAt: number };
type Creation = { readonly title: string; readonly parentThreadId?: string; readonly participants?: readonly string[] };
const contexts = new WeakMap<FeatureContext, ReturnType<typeof createMappings>>();
/** Package-owned external-conversation mapping. Host receives ordinary thread calls only. */
function createMappings(context: FeatureContext) {
  const key = 'thread-mappings.v1';
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(run: () => Promise<T>): Promise<T> => {
    const next = tail.then(run, run); tail = next.catch(() => {}); return next;
  };
  const read = async () => {
    const stored = await context.storage.get(key);
    const rows = stored?.value ?? [];
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row.key !== 'string' || typeof row.threadId !== 'string' || typeof row.createdAt !== 'number'))
      throw new Error('Invalid plugin thread mappings');
    return { stored, rows: rows as Mapping[] };
  };
  const find = async (name: string) => {
    const { rows } = await read(); const row = rows.find(row => row.key === name);
    return row ? context.threads.get(row.threadId) : null;
  };
  const save = async (name: string, threadId: string | null) => {
    const { stored, rows } = await read();
    const next = rows.filter(row => row.key !== name);
    if (threadId !== null) {
      if (!await context.threads.get(threadId)) throw new Error('Thread unavailable');
      next.push({ key: name, threadId, createdAt: Date.now() });
    }
    const result = await context.storage.compareAndSet(key, stored?.revision ?? null, next);
    if (!result.applied) throw new Error('Plugin thread mappings changed concurrently');
    return threadId === null ? rows.length !== next.length : next.find(row => row.key === name)!;
  };
  const ensure = (name: string, input: Creation) => serialize(async () => {
    const existing = await find(name);
    if (existing) return existing;
    const thread = await context.threads.create(input);
    await save(name, thread.id); return thread;
  });
  return {
    ...context.threads,
    findByKey: find,
    bind: (name: string, threadId: string) => serialize(() => save(name, threadId)),
    unbind: (name: string) => serialize(() => save(name, null)),
    listBindings: async () => (await read()).rows,
    ensureByKey: ensure,
    ensureSystemThread: () => ensure('command-audit', { title: '连接器命令记录' }),
  };
}
export function threadMappings(context: FeatureContext) {
  let value = contexts.get(context);
  if (!value) { value = createMappings(context); contexts.set(context, value); }
  return value;
}
