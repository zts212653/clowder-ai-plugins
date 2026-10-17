import type { PluginThreadHost, PluginThreadSummary } from './module-host.js';
import type { ConnectorCommandName, ConnectorPermissions } from './connector-permissions.js';
import type { ConnectorCommandIngress, ConnectorCommandResult } from './connector-command-router.js';
import { executeConnectorPermissionCommand } from './connector-command-router.js';
import { allCommandCats, formatConnectorCats, formatConnectorCommands, formatConnectorHistory, resolveCommandCat } from './connector-command-format.js';

/** Uses the accepted generic Host thread projections, never private stores. */
export type ConnectorCommandThread = PluginThreadSummary;
export interface ConnectorCommandServices {
  readonly connectorId: string;
  readonly threads: Pick<PluginThreadHost, 'get' | 'findByKey' | 'create' | 'bind' | 'unbind' | 'list' | 'update' | 'getCats' | 'readMessages'>;
  readonly permissions: {
    get(): Promise<ConnectorPermissions>;
    allowGroup(id: string): Promise<{ readonly allowedGroups: readonly unknown[] }>;
    denyGroup(id: string): Promise<boolean>;
  };
  bindingChanged(input: { chatId: string; previousThreadId?: string; threadId?: string }): Promise<void>;
  now(): number;
}

// Must match Host's owner-visible keyset: activity descending, JS strings
// ascending for ties. Locale-dependent sorting changes cursor boundaries.
function comparePosition(a: Pick<ConnectorCommandThread, 'lastActiveAt' | 'id'>, b: Pick<ConnectorCommandThread, 'lastActiveAt' | 'id'>): number {
  return b.lastActiveAt - a.lastActiveAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function selectThread(input: string, threads: readonly ConnectorCommandThread[]): ConnectorCommandThread | undefined {
  // The list is already ordered by activity. Preserve feature -> list index -> ID prefix -> title precedence.
  const selectors = [
    () => /^F\d+$/i.test(input) ? threads.find(t => t.featureRefs?.some(ref => ref.toUpperCase() === input.toUpperCase())) : undefined,
    () => /^\d+$/.test(input) && Number(input) >= 1 && Number(input) <= Math.min(10, threads.length) ? threads[Number(input) - 1] : undefined,
    () => threads.find(t => t.id.startsWith(input)),
    () => threads.find(t => t.title?.toLocaleLowerCase().includes(input.toLocaleLowerCase())),
  ];
  for (const select of selectors) { const match = select(); if (match) return match; }
  return undefined;
}

export function createConnectorCommandService(services: ConnectorCommandServices) {
  const link = (thread: ConnectorCommandThread): string => `\n🔗 ${thread.deepLinkUrl}`;
  const inventory = async (recentOnly = false) => {
    const found = new Map<string, ConnectorCommandThread>();
    let before: { lastActiveAt: number; id: string } | undefined;
    // Each call remains bounded to50. Refuse an incomplete/hostile traversal
    // rather than silently turning a partial inventory into "not found".
    for (let page = 0; page < 200; page++) {
      const rows = await services.threads.list({ limit: 50, ...(before === undefined ? {} : { before }) });
      if (rows.length > 50) throw new TypeError('thread inventory page exceeds Host limit');
      for (const row of rows) if (!found.has(row.id)) found.set(row.id, row);
      if (recentOnly || rows.length < 50) return [...found.values()].sort(comparePosition);
      const last = rows[rows.length - 1]!;
      if (before !== undefined && comparePosition(last, before) <= 0) throw new Error('thread inventory cursor did not progress');
      before = { lastActiveAt: last.lastActiveAt, id: last.id };
    }
    throw new Error('thread inventory traversal limit reached; use /thread with a full thread ID');
  };
  const bind = async (chatId: string, threadId: string) => {
    const previous = await services.threads.findByKey(chatId);
    await services.threads.bind(chatId, threadId);
    await services.bindingChanged({ chatId, ...(previous === null ? {} : { previousThreadId: previous.id }), threadId });
  };
  return async (command: { name: ConnectorCommandName; args: string }, input: ConnectorCommandIngress): Promise<ConnectorCommandResult> => {
    const args = command.args.trim();
    switch (command.name) {
      case 'commands': return formatConnectorCommands();
      case 'allow-group':
      case 'deny-group': {
        const policy = await services.permissions.get();
        return executeConnectorPermissionCommand({ name: command.name, args }, input, policy, services.permissions);
      }
      case 'new': {
        const thread = await services.threads.create({ title: args || '新对话' });
        await bind(input.chatId, thread.id);
        return { response: `✨ 新 thread${args ? ` "${args}"` : ''} 已创建\nID: ${thread.id}${link(thread)}\n\n现在的消息会发到这个 thread。` };
      }
      case 'threads': {
        const threads = (await inventory(true)).slice(0, 10);
        if (!threads.length) return { response: '📋 还没有 thread。发送消息或用 /new 创建一个吧！' };
        return { response: `📋 最近的 threads:\n\n${threads.map((t, i) => `${i + 1}. ${t.title ?? '(无标题)'}${t.featureRefs?.length ? ` [${t.featureRefs.join(',')}]` : ''} [${t.id}]`).join('\n')}\n\n用 /use F088 或 /use 关键词 或 /use 3 切换`,
          cardActions: threads.slice(0, 5).map((t, i) => ({ label: `${i + 1}. ${(t.title ?? '(无标题)').slice(0, 12)}`, value: { cmd: '/use', args: String(i + 1) } })),
        };
      }
      case 'use': {
        if (!args) return { response: '❌ 用法: /use F088 | /use 关键词 | /use 3 | /use <ID前缀>\n用 /threads 查看可用列表。' };
        const thread = selectThread(args, await inventory());
        if (!thread) return { response: `❌ 找不到匹配 "${args}" 的 thread。用 /threads 查看可用列表。` };
        await bind(input.chatId, thread.id);
        return { response: `🔄 已切换到: ${thread.title ?? '(无标题)'}\nID: ${thread.id}${link(thread)}` };
      }
      case 'thread': {
        const [prefix, ...body] = args.split(/\s+/);
        if (!prefix || !body.length) return { response: '❌ 用法: /thread <thread_id> <message>\n切换到指定 thread 并发送消息。' };
        const exact = await services.threads.get(prefix);
        const thread = exact ?? (await inventory()).find(t => t.id.startsWith(prefix));
        if (!thread) return { response: `❌ 找不到 thread "${prefix}"。用 /threads 查看可用列表。` };
        await bind(input.chatId, thread.id);
        return { response: `📨 → ${thread.title ?? '(无标题)'} [${thread.id}]`, forward: { threadId: thread.id, text: body.join(' ') } };
      }
    }
    const bound = await services.threads.findByKey(input.chatId);
    if (!bound) return { response: '📍 当前没有绑定的 thread。发送消息或用 /new 创建新 thread，或用 /use 切换。' };
    switch (command.name) {
      case 'where': return { response: `📍 当前 thread: ${bound.title ?? '(无标题)'}\nID: ${bound.id}${link(bound)}` };
      case 'unbind': {
        await services.threads.unbind(input.chatId);
        await services.bindingChanged({ chatId: input.chatId, previousThreadId: bound.id });
        return { response: `🔓 已解绑: ${bound.title ?? '(无标题)'} [${bound.id}]\n\n下一条消息会自动创建新 thread，或用 /use 切换到已有 thread。` };
      }
      case 'cats': return { response: formatConnectorCats(await services.threads.getCats(bound.id)) };
      case 'status': {
        const cats = await services.threads.getCats(bound.id);
        const names = new Map(allCommandCats(cats).map(cat => [cat.catId, cat.displayName]));
        const last = cats.participants.length ? Math.max(...cats.participants.map(cat => cat.lastMessageAt)) : undefined;
        return { response: ['📊 Thread 状态', `  标题：${bound.title ?? '(无标题)'}`, `  创建：${new Date(bound.createdAt).toLocaleDateString('zh-CN')}`,
          `  参与猫：${cats.participants.length} 只`, `  最近活跃：${last === undefined ? '未知' : Math.max(0, Math.floor((services.now() - last) / 60000)) + ' 分钟前'}`,
          ...(bound.preferredCats?.length ? [`  首选猫：${bound.preferredCats.map(id => names.get(id) ?? id).join(', ')}`] : []), link(bound).trim(),
        ].filter(Boolean).join('\n') };
      }
      case 'focus': {
        if (!args) return { response: bound.preferredCats?.length ? `🐱 当前首选猫：${bound.preferredCats.join(', ')}` : '🐾 当前未设置首选猫，使用全局默认。' };
        if (args === 'clear') {
          await services.threads.update(bound.id, { preferredCats: [] });
          return { response: '✅ 已清除首选猫设置，回到全局默认。' };
        }
        const cat = resolveCommandCat(args, await services.threads.getCats(bound.id));
        if ('response' in cat) return cat;
        await services.threads.update(bound.id, { preferredCats: [cat.catId] });
        return { response: `🐱 已将首选猫设为 ${cat.catId}` };
      }
      case 'ask': {
        const [name, ...body] = args.split(/\s+/);
        if (!name || !body.length) return { response: '用法：/ask <猫名> <消息>' };
        const cat = resolveCommandCat(name, await services.threads.getCats(bound.id));
        if ('response' in cat) return cat;
        return { response: `🎯 已定向发送给 ${cat.catId}`, forward: { threadId: bound.id, catId: cat.catId, text: body.join(' ') } };
      }
      case 'history': {
        if (args === 'pick') return { response: '📜 查看几轮对话？', cardActions: ['1', '3', '5'].map(count => ({ label: `最近 ${count} 轮`, value: { cmd: '/history', args: count } })) };
        if (args && !/^[1-5]$/.test(args)) return { response: '❌ 用法: /history [1-5]（默认 1 轮）' };
        const count = args ? Number(args) : 1;
        // No cursor means the latest page, including records at the current timeline
        // millisecond. Never manufacture a cursor from the local clock.
        const messages = await services.threads.readMessages(bound.id, { limit: Math.max(200, count * 100) });
        const cats = await services.threads.getCats(bound.id);
        return { response: formatConnectorHistory({ connectorId: services.connectorId, messages, count, cats, threadUrl: bound.deepLinkUrl }) };
      }
    }
  };
}
