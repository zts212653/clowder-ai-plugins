import { isPluginDeliveryInput, type PluginMessageDelivery } from '@clowder-ai/plugin-contract';
import { z } from 'zod';
import type { SuperagentHost } from './runtime.js';

const id = z.string().trim().min(1).max(500);
export const preferencesSchema = z
  .object({
    v: z.literal(1).default(1),
    name: z.string().min(1).max(80).default('我的助手'),
    enabled: z.boolean().default(false),
    started: z.boolean().default(false),
    coordinatorId: id.optional(),
    workerIds: z.array(id).default([]),
    threadIds: z.array(id).default([]),
    responsibility: z.string().max(4000).default(''),
  })
  .strict();
export type Preferences = z.infer<typeof preferencesSchema>;
export async function editPreferences(
  host: SuperagentHost,
  update: (value: Preferences) => Preferences,
  current: () => Promise<void>,
) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const row = await host.storage.get('preferences');
    const next = update(preferencesSchema.parse(row?.value ?? {}));
    await current();
    if ((await host.storage.compareAndSet('preferences', row?.revision ?? null, next)).applied) return next;
  }
  throw new Error('设置正在更新，请重试本次选择');
}
export const runtimeSchema = z.object({ mainThreadId: id.optional(), error: z.string().optional() }).strict();
export const inboxSchema = z
  .object({
    delivery: z.custom<PluginMessageDelivery>((v) => isPluginDeliveryInput(v) && v.kind === 'message'),
    phase: z.enum(['pending', 'routed', 'failed', 'done']),
    attempt: z.number().int().nonnegative().default(0),
    wakeMessageId: id.optional(),
    receivedAt: z.number(),
  })
  .strict();
export const decisionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('start'),
      title: z.string().min(1).max(180),
      outcome: z.string().min(1).max(4000),
      workerId: id,
      questionId: id.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('follow_up'),
      workId: id,
      content: z.string().min(1).max(16000),
      questionId: id.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('ask'),
      workId: id.optional(),
      content: z.string().min(1).max(4000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('deliver'),
      workId: id,
      content: z.string().min(1).max(16000),
    })
    .strict(),
  z.object({ kind: z.literal('accept'), workId: id }).strict(),
  z
    .object({
      kind: z.literal('ignore'),
      reason: z.string().min(1).max(1000),
      questionId: id.optional(),
    })
    .strict(),
]);
export const planSchema = z
  .object({
    eventId: id,
    decisions: z.array(decisionSchema).min(1).max(10),
    applied: z.boolean().default(false),
  })
  .strict();
export const workSchema = z
  .object({
    key: id,
    title: z.string(),
    outcome: z.string(),
    workerId: id,
    threadId: id,
    sourceThreadId: id,
    sourceMessageId: id,
    taskId: id.optional(),
  })
  .strict();
export type WorkLink = z.infer<typeof workSchema>;
export const reportSchema = z
  .object({
    workId: id,
    reportId: id,
    kind: z.enum(['progress', 'question', 'result', 'error']),
    content: z.string().min(1).max(16000),
    applied: z.boolean().default(false),
    invocationId: id,
  })
  .strict();
export const questionSchema = z
  .object({
    id,
    workId: id.optional(),
    sourceThreadId: id,
    content: z.string(),
    resolved: z.boolean().default(false),
  })
  .strict();
const queueSchema = z.object({
  inbox: z.array(id).default([]),
  plans: z.array(id).default([]),
  reports: z.array(id).default([]),
  works: z.array(id).default([]),
  questions: z.array(id).default([]),
});
type QueueKind = keyof z.infer<typeof queueSchema>;

/** Small durable pending index; historical events stay intact and are not scanned every tick. */
export async function editQueue(host: SuperagentHost, kind: QueueKind, id: string, add: boolean) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const row = await host.storage.get('queue');
    const queue = queueSchema.parse(row?.value ?? {});
    const next = add ? [...new Set([...queue[kind], id])] : queue[kind].filter((entry) => entry !== id);
    if (JSON.stringify(next) === JSON.stringify(queue[kind])) return;
    const written = await host.storage.compareAndSet('queue', row?.revision ?? null, { ...queue, [kind]: next });
    if (written.applied) return;
  }
  throw new Error('Superagent pending index is busy; retry the original delivery');
}

export async function queued<T>(host: SuperagentHost, kind: QueueKind, prefix: string, schema: z.ZodType<T>) {
  const queue = queueSchema.parse((await host.storage.get('queue'))?.value ?? {});
  return (await Promise.all(queue[kind].map((id) => read(host, `${prefix}${id}`, schema)))).filter(
    (entry) => entry !== undefined,
  );
}

export async function read<T>(host: SuperagentHost, key: string, schema: z.ZodType<T>) {
  const row = await host.storage.get(key);
  return row ? schema.parse(row.value) : undefined;
}

export function records<T>(host: SuperagentHost, prefix: 'work:' | 'question:', schema: z.ZodType<T>) {
  return queued(host, prefix === 'work:' ? 'works' : 'questions', prefix, schema);
}

export async function saveOnce<T extends { applied: boolean }>(host: SuperagentHost, key: string, value: T) {
  const result = await host.storage.compareAndSet(key, null, value);
  if (!result.applied) {
    const before = await host.storage.get(key);
    const { applied: _previousPhase, ...previous } = z
      .object({ applied: z.boolean() })
      .passthrough()
      .parse(before?.value);
    const { applied: _nextPhase, ...next } = value;
    if (JSON.stringify(previous) !== JSON.stringify(next)) throw new Error('Superagent operation ID conflict');
  }
}
