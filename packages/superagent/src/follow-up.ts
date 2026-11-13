import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SuperagentHost } from './runtime.js';
import { type Preferences, read } from './state.js';
import { send } from './work.js';

const snapshotSchema = z.object({
  seen: z.record(z.string(), z.string()),
  nextAt: z.number(),
});

export async function watchedSources(host: SuperagentHost, preferences: Preferences) {
  const threads = await host.threads.list({ threadIds: preferences.threadIds });
  return Promise.all(threads.map(async (thread) => ({
    threadId: thread.id,
    title: thread.title,
    deepLinkUrl: thread.deepLinkUrl,
    existingWork: (await host.tasks.list({ threadId: thread.id, kind: 'work' }))
      .filter((task) => !task.subjectKey?.startsWith(`superagent:${host.pluginInstanceId}:`)),
  })));
}

export async function followUp(host: SuperagentHost, preferences: Preferences, mainThreadId: string) {
  const before = await read(host, 'follow-up', snapshotSchema);
  const now = Date.now();
  if (before && now < before.nextAt) return;
  const sources = await watchedSources(host, preferences);
  const rows = sources.flatMap((source) => source.existingWork.map((task) => ({
    task,
    source,
    state: `${task.status}:${task.entrustedWork?.closure.state ?? 'legacy'}`,
    result: task.entrustedWork
      ? task.entrustedWork.closure.state === 'satisfied'
        ? '已完成'
        : task.entrustedWork.closure.state === 'open' && task.status === 'blocked' ? '受阻' : undefined
      : task.status === 'done' ? '已完成' : task.status === 'blocked' ? '受阻' : undefined,
  })));
  const changes = rows.filter((row) => row.result && before?.seen[row.task.id] !== row.state)
    .sort((a, b) => b.task.updatedAt - a.task.updatedAt || a.task.id.localeCompare(b.task.id));
  if (changes.length) {
    const completed = changes.filter((row) => row.result === '已完成').length;
    const blocked = changes.length - completed;
    const key = createHash('sha256').update(JSON.stringify(changes.map((row) => [
      row.task.id, before?.seen[row.task.id], row.state, row.task.updatedAt,
    ]))).digest('hex');
    await send(host, mainThreadId, `follow-up:${key}`, [
      `进展更新：已完成 ${completed} 项，受阻 ${blocked} 项。`,
      ...changes.slice(0, 3).map((row) => [
        `- 【${row.result}】${row.task.title}`,
        `  来自：[${(row.source.title ?? row.task.title).replace(/[\[\]\\]/g, '\\$&')}](${row.source.deepLinkUrl})`,
        ...(row.task.why ? [`  背景：${row.task.why.slice(0, 180)}`] : []),
        row.result === '已完成' ? '  后续：完成记录已确认，结果留在原会话。' : '  待跟进：受阻原因与处理方案尚待原负责人明确。',
      ].join('\n')),
      ...(changes.length > 3 ? [`另有 ${changes.length - 3} 项变化，可问“展开进展”查看。`] : []),
    ].join('\n'));
  }
  await host.storage.set('follow-up', {
    seen: { ...before?.seen, ...Object.fromEntries(rows.map((row) => [row.task.id, row.state])) },
    nextAt: now + 60_000,
  });
}
