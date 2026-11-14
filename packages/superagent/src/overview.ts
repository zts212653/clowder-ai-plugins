import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SuperagentHost } from './runtime.js';
import { type Preferences, questionSchema, read, records, workSchema } from './state.js';
import { send } from './work.js';

const rowSchema = z.object({
  threadId: z.string().min(1).max(500),
  status: z.enum(['needs_you', 'blocked', 'doing', 'waiting_acceptance', 'done', 'quiet', 'unknown']),
  progress: z.string().trim().min(1).max(180),
  blocker: z.string().trim().max(140),
  nextStep: z.string().trim().min(1).max(180),
  evidenceIds: z.array(z.string().min(1).max(500)).max(20),
}).strict();
export const overviewInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('refresh') }).strict(),
  z.object({ kind: z.literal('publish'), requestId: z.string().min(1).max(100), rows: z.array(rowSchema).max(5000) }).strict(),
]);
const sourceSchema = z.object({
  threadId: z.string(), title: z.string(), deepLinkUrl: z.string().optional(), available: z.boolean(), lastActiveAt: z.number(),
  recent: z.array(z.object({ id: z.string(), timestamp: z.number(), content: z.string(), sender: z.string(), catId: z.string().optional(), responseStatus: z.string().optional() })),
  existingWork: z.array(z.object({ id: z.string(), title: z.string(), status: z.string(), ownerCatId: z.string().nullable(), why: z.string(), updatedAt: z.number(), closure: z.string().optional() })),
  questions: z.array(z.object({ id: z.string(), content: z.string() })),
});
export const overviewSchema = z.object({
  requestId: z.string(), phase: z.enum(['pending', 'done', 'failed']), capturedAt: z.number(), nextCheckAt: z.number(), nextRequestAt: z.number(),
  sources: z.array(sourceSchema), rows: z.array(rowSchema).optional(), wakeMessageId: z.string().optional(), error: z.string().optional(),
});

export async function watchedSources(host: SuperagentHost, preferences: Preferences) {
  const threads = await host.threads.list({ threadIds: preferences.threadIds });
  const works = await records(host, 'work:', workSchema);
  const questions = (await records(host, 'question:', questionSchema)).filter((question) => !question.resolved);
  const sources: z.infer<typeof sourceSchema>[] = [];
  // Bounded sequential reads avoid exhausting the shared execution RPC capacity.
  for (const threadId of preferences.threadIds) {
    const thread = threads.find((entry) => entry.id === threadId);
    const [messageRead, taskRead] = await Promise.allSettled([
      thread ? host.threads.readMessages(threadId, { limit: 30 }) : Promise.resolve([]),
      thread ? host.tasks.list({ threadId, kind: 'work' }) : Promise.resolve([]),
    ]);
    const messages = messageRead.status === 'fulfilled' ? messageRead.value : [];
    const listedTasks = taskRead.status === 'fulfilled' ? taskRead.value : [];
    const tasks = [...listedTasks];
    const relatedQuestions = [];
    for (const work of works.filter((entry) => entry.sourceThreadId === threadId)) {
      if ((await host.messaging.get(work.sourceMessageId))?.catId) continue;
      const task = work.taskId ? await host.tasks.get({ id: work.taskId }) : null;
      if (task && !tasks.some((entry) => entry.id === task.id)) tasks.push(task);
      relatedQuestions.push(...questions.filter((question) => question.workId === work.taskId));
    }
    const relevant = messages.filter((message) => message.sender.kind !== 'system');
    const lastOwner = relevant.filter((message) => message.sender.kind === 'owner').at(-1);
    const recent = [...new Map([...relevant.slice(-3), ...(lastOwner ? [lastOwner] : [])].map((message) => [message.id, message])).values()]
      .sort((a, b) => a.timestamp - b.timestamp);
    sources.push({
      threadId, title: thread?.title ?? threadId, deepLinkUrl: thread?.deepLinkUrl, available: !!thread && messageRead.status === 'fulfilled' && taskRead.status === 'fulfilled', lastActiveAt: thread?.lastActiveAt ?? 0,
      recent: recent.map((message) => ({ id: message.id, timestamp: message.timestamp, content: message.content.slice(0, 1400), sender: message.sender.kind, catId: message.sender.catId, responseStatus: message.response?.status })),
      existingWork: tasks.map((task) => ({ id: task.id, title: task.title, status: task.status, ownerCatId: task.ownerCatId, why: task.why.slice(0, 300), updatedAt: task.updatedAt, closure: task.entrustedWork?.closure.state })),
      questions: [...new Map([...relatedQuestions, ...questions.filter((question) => !question.workId && question.sourceThreadId === threadId)].map((question) => [question.id, { id: question.id, content: question.content.slice(0, 1400) }])).values()],
    });
  }
  return sources;
}

export async function refreshOverview(host: SuperagentHost, pref: Preferences, coordinationThreadId: string, refresh = false) {
  const before = await read(host, 'overview', overviewSchema);
  const now = Date.now();
  if (!refresh && (!pref.started || before && now < before.nextCheckAt)) return before;
  const sameScope = JSON.stringify(pref.threadIds) === JSON.stringify(before?.sources.map((source) => source.threadId));
  if (before?.phase === 'pending' && sameScope) {
    const response = (await host.threads.readMessages(coordinationThreadId, { limit: 100 })).find((message) =>
      message.sender.catId === pref.coordinatorId && message.response?.inputMessageIds.includes(before.wakeMessageId ?? ''))?.response;
    if (response && response.status !== 'processing') {
      const failed = { ...before, phase: 'failed' as const, error: '总览尚未提交；原会话与上一份总览保留，可在助手里要求刷新。' };
      await host.storage.set('overview', failed);
      return failed;
    }
    return before;
  }
  if (!refresh && before?.phase === 'failed' && sameScope) return before;
  const sources = await watchedSources(host, pref);
  const fingerprint = createHash('sha256').update(JSON.stringify(sources)).digest('hex');
  if (before?.phase === 'done' && fingerprint === createHash('sha256').update(JSON.stringify(before.sources)).digest('hex')) {
    const checked = { ...before, nextCheckAt: now + 60_000 };
    await host.storage.set('overview', checked);
    return checked;
  }
  const scopeChanged = JSON.stringify(sources.map((source) => source.threadId)) !== JSON.stringify(before?.sources.map((source) => source.threadId));
  if (!refresh && !scopeChanged && before && now < before.nextRequestAt) return before;
  const requestId = randomUUID();
  const request = { requestId, phase: 'pending' as const, sources, capturedAt: now, nextCheckAt: now + 60_000, nextRequestAt: now + 10 * 60_000, rows: before?.rows };
  const wake = await send(host, coordinationThreadId, `overview:${requestId}`,
    `请整理全部监听会话的全局总览。通过 plugin_list_tools 发现 official.superagent，调用 superagent_inspect 读取 overview.sources，再调用 superagent_overview(kind=publish, requestId, rows)。每个来源恰好一行，引用本批消息/Task 的 evidenceIds；没有证据标 unknown，不能漏掉无 Task 会话。先需要用户决定/验收，再具体阻塞、进行中、安静/完成。progress尽量45字内，blocker和nextStep各30字内：只说用户能理解的成果、卡点、谁继续、需要用户做什么；不要SHA、工位、CI计数、清理数量或内部方案代号，细节留来源。区分回复结束、方案完成和正式验收；不猜已完成或负责人/截止时间。超过48小时无实质更新可标quiet，注明最后观察。只提交总览，不route/start、不创建Task/工作线程、不跨发聊天回复到助手。`, pref.coordinatorId);
  const next = { ...request, wakeMessageId: wake.messageId };
  await host.storage.set('overview', next);
  return next;
}

export async function publishOverview(host: SuperagentHost, pref: Preferences, mainThreadId: string, input: Extract<z.infer<typeof overviewInputSchema>, { kind: 'publish' }>) {
  const overview = await read(host, 'overview', overviewSchema);
  if (!overview || input.requestId !== overview.requestId) throw new Error('总览请求已变化，请重新读取 inspect.overview');
  const selected = pref.threadIds;
  if (input.rows.length !== selected.length || new Set(input.rows.map((row) => row.threadId)).size !== selected.length || selected.some((id) => !input.rows.some((row) => row.threadId === id)))
    throw new Error('总览必须逐一覆盖全部监听会话，不能遗漏或重复 coverage');
  for (const row of input.rows) {
    const source = overview.sources.find((entry) => entry.threadId === row.threadId);
    if (!source) throw new Error('监听范围已变化，请刷新总览');
    const evidence = [...source.recent, ...source.existingWork, ...source.questions].map((entry) => entry.id);
    if (row.evidenceIds.some((id) => !evidence.includes(id)) || (!row.evidenceIds.length && !['unknown', 'quiet'].includes(row.status)))
      throw new Error('总览判断缺少本来源证据 evidence');
    if (row.status === 'done' && source.existingWork.some((task) => task.closure === 'open' || !task.closure && task.status !== 'done'))
      throw new Error('正式任务尚未闭合，不能把回复结束当作已完成');
  }
  if (overview.phase === 'done') {
    if (JSON.stringify(overview.rows) !== JSON.stringify(input.rows)) throw new Error('同一总览已提交，请刷新后修改');
    return overview;
  }
  const labels = { needs_you: '需要你决定', waiting_acceptance: '待你验收', blocked: '受阻', doing: '进行中', done: '已完成', quiet: '安静', unknown: '待核实' };
  const order: z.infer<typeof rowSchema>['status'][] = ['needs_you', 'waiting_acceptance', 'blocked', 'doing', 'unknown', 'quiet', 'done'];
  const rows = [...input.rows].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || selected.indexOf(a.threadId) - selected.indexOf(b.threadId));
  const previous = await read(host, 'overview-published', z.array(rowSchema));
  const meaning = (items: z.infer<typeof rowSchema>[]) => JSON.stringify(items.map(({ evidenceIds: _evidence, ...row }) => row));
  if (!previous || meaning(previous) !== meaning(input.rows)) await send(host, mainThreadId, `overview-result:${overview.requestId}`, [
    `**监听会话总览 · ${rows.length}/${selected.length} 个会话**`,
    order.map((status) => `${labels[status]} ${rows.filter((row) => row.status === status).length}`).join(' · '),
    `截至 ${new Date(overview.capturedAt).toISOString().replace('T', ' ').slice(0, 16)} UTC；原会话继续处理。`,
    ...rows.map((row) => {
      const source = overview.sources.find((entry) => entry.threadId === row.threadId)!;
      const title = source.title.replace(/[\[\]\\]/g, '\\$&');
      return `- **【${labels[row.status]}】${source.deepLinkUrl ? `[${title}](${source.deepLinkUrl})` : title}**：${row.progress}\n  ${row.blocker ? `阻塞：${row.blocker}；` : ''}下一步：${row.nextStep}`;
    }),
  ].join('\n\n'));
  await host.storage.set('overview-published', input.rows);
  const next = { ...overview, rows: input.rows, phase: 'done' as const };
  await host.storage.set('overview', next);
  return next;
}
