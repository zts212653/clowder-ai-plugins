import type { ConnectorCommandResult } from './connector-command-router.js';
import type { ConnectorCommandName } from './connector-permissions.js';
import type { PluginThreadCat, PluginThreadCats, PluginThreadMessage } from './module-host.js';

export type ConnectorCommandCat = PluginThreadCat;
export type ConnectorCommandCats = PluginThreadCats;
export type ConnectorHistoryMessage = PluginThreadMessage;

export const CONNECTOR_COMMAND_DECLARATIONS: readonly { name: ConnectorCommandName; usage: string; description: string }[] = [
  { name: 'commands', usage: '/commands', description: '列出所有可用命令' },
  { name: 'cats', usage: '/cats', description: '查看当前 thread 的猫猫' },
  { name: 'status', usage: '/status', description: '查看当前 thread 状态' },
  { name: 'where', usage: '/where', description: '查看当前绑定的 thread' },
  { name: 'new', usage: '/new [标题]', description: '创建新 thread 并切换' },
  { name: 'threads', usage: '/threads', description: '列出最近的 threads' },
  { name: 'use', usage: '/use <F号|序号|关键词>', description: '切换到指定 thread' },
  { name: 'thread', usage: '/thread <id> <消息>', description: '切换并发送消息' },
  { name: 'unbind', usage: '/unbind', description: '解除当前绑定' },
  { name: 'history', usage: '/history [1-5]', description: '查看最近 N 轮对话（默认 1）' },
  { name: 'allow-group', usage: '/allow-group [群ID]', description: '管理员允许群聊' },
  { name: 'deny-group', usage: '/deny-group [群ID]', description: '管理员移除允许的群聊' },
  { name: 'focus', usage: '/focus [猫名|clear]', description: '查看、设置或清除首选猫' },
  { name: 'ask', usage: '/ask <猫名> <消息>', description: '一次性定向发送给猫猫' },
];
export function formatConnectorCommands(): ConnectorCommandResult {
  return { response: `📋 可用命令：\n\n${CONNECTOR_COMMAND_DECLARATIONS.map(c => `  ${c.usage} — ${c.description}`).join('\n')}`,
    cardActions: CONNECTOR_COMMAND_DECLARATIONS.map(c => ({ label: c.description, value: {
      cmd: `/${c.name}`, ...(c.name === 'history' ? { args: 'pick' } : {}),
    } })),
  };
}
export function allCommandCats(cats: ConnectorCommandCats): readonly ConnectorCommandCat[] {
  const result = new Map<string, ConnectorCommandCat>();
  for (const cat of [...cats.participants, ...cats.routableNow, ...cats.routableNotJoined, ...cats.notRoutable]) result.set(cat.catId, cat);
  return [...result.values()];
}
export function resolveCommandCat(input: string, cats: ConnectorCommandCats): { catId: string } | { response: string } {
  const key = input.trim().replace(/^@/, '').toLocaleLowerCase();
  const matches = allCommandCats(cats).filter(cat => [cat.catId, cat.displayName, ...cat.aliases].some(alias => alias.replace(/^@/, '').toLocaleLowerCase() === key));
  if (matches.length === 1) {
    const catId = matches[0]!.catId;
    if (![...cats.routableNow, ...cats.routableNotJoined].some(cat => cat.catId === catId)) {
      return { response: `💤 猫「${input}」当前不可调度。` };
    }
    return { catId };
  }
  return { response: matches.length > 1
    ? `🤔 找到多只匹配的猫：${matches.map(c => c.catId).join(', ')}，请输入更精确的名字。`
    : `❌ 找不到猫「${input}」。` };
}
export function formatConnectorCats(cats: ConnectorCommandCats): string {
  const routable = new Set(cats.routableNow.map(c => c.catId));
  const lines: string[] = [];
  if (cats.participants.length) lines.push('🐾 参与猫：', ...cats.participants.map(p => `  ${routable.has(p.catId) ? '✅' : '⚠️'} ${p.displayName}（${p.messageCount} 条消息）`));
  if (cats.routableNotJoined.length) lines.push('\n📡 可调度（未加入）：', ...cats.routableNotJoined.map(c => `  ${c.displayName}`));
  if (cats.notRoutable.length) lines.push('\n💤 不可调度：', ...cats.notRoutable.map(c => `  ${c.displayName}`));
  return lines.join('\n') || '没有找到猫猫。';
}

/** Legacy round selection and water-filling, with a hard final provider budget. */
export function formatConnectorHistory(input: {
  connectorId: string; messages: readonly ConnectorHistoryMessage[]; count: number;
  cats: ConnectorCommandCats; threadUrl?: string;
}): string {
  if (!input.messages.length) return '📜 本线程还没有消息。';
  const rounds: ConnectorHistoryMessage[][] = [];
  for (const message of input.messages) {
    if (!rounds.length || (message.sender.kind === 'owner' && rounds.at(-1)!.length)) rounds.push([]);
    rounds.at(-1)!.push(message);
  }
  const selected = rounds.slice(-input.count);
  const names = new Map(allCommandCats(input.cats).map(c => [c.catId, c.displayName]));
  const meta = selected.flat().map(message => {
    const name = message.sender.kind === 'cat' ? `🐱 ${names.get(message.sender.catId ?? '') ?? message.sender.catId ?? '猫猫'}`
      : message.sender.kind === 'system' ? '🔔 系统' : '👤 你';
    const time = new Date(message.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    return { message, prefix: `**${name}** [${time}]: ` };
  });
  const budgets: Record<string, number> = { feishu: 10000, dingtalk: 6000, telegram: 4000, 'wecom-bot': 2000, 'wecom-agent': 2000, weixin: 2000, xiaoyi: 2000 };
  const budget = budgets[input.connectorId] ?? 2000;
  const header = input.count === 1 ? '📜 最近 1 轮对话：' : `📜 最近 ${selected.length} 轮对话：`;
  const footer = `\n\n⚠️ 内容已精简，完整对话请打开 thread${input.threadUrl === undefined ? '' : `\n🔗 ${input.threadUrl}`}`;
  const overhead = header.length + 2 + meta.reduce((n, m) => n + m.prefix.length + 2, 0) + selected.length * 4 + footer.length;
  let remaining = Math.max(0, budget - overhead);
  let left = meta.length;
  let ceiling = Infinity;
  for (const length of meta.map(m => m.message.content.length).sort((a, b) => a - b)) {
    const share = Math.floor(remaining / left);
    if (length > share) { ceiling = share; break; }
    remaining -= length; left--;
  }
  let truncated = false;
  let index = 0;
  const body = selected.map(round => round.map(() => {
    const { prefix, message } = meta[index++]!;
    const shorten = message.content.length > ceiling;
    truncated ||= shorten;
    return prefix + (shorten ? `${message.content.slice(0, ceiling)}…` : message.content);
  }).join('\n')).join('\n---\n');
  const response = `${header}\n\n${body}`;
  if (!truncated && response.length <= budget) return response;
  return response.slice(0, Math.max(0, budget - footer.length)) + footer;
}
