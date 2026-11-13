import type { PluginActionHandler, PluginHostActionContext } from '@clowder-ai/plugin-sdk';
import { z } from 'zod';
import type { SuperagentHost } from './runtime.js';
import {
  editPreferences,
  editQueue,
  inboxSchema,
  type Preferences,
  preferencesSchema,
  queued,
  read,
  records,
  runtimeSchema,
  workSchema,
} from './state.js';

async function owner(context: PluginHostActionContext | undefined, confirmation = false) {
  if (!context || context.kind !== 'owner-operation' || (confirmation && !context.confirmed))
    throw new Error('请在插件设置中确认此操作');
  await context.assertCurrent();
}

export function createSettings(
  host: SuperagentHost,
  preferences: () => Promise<Preferences>,
  refresh: () => Promise<unknown>,
  current: () => void,
) {
  async function members(selection: 'coordinator' | 'worker') {
    current();
    const pref = await preferences();
    if (!host.members) throw new Error('Host member directory unavailable');
    const available = (await host.members.list()).filter(
      (member) =>
        member.available ||
        (selection === 'coordinator' ? pref.coordinatorId === member.catId : pref.workerIds.includes(member.catId)),
    );
    return {
      render: 'rows',
      data: {
        empty: '暂无可用的 Agent，请先在猫猫团队中启用成员。',
        rows: [
          ...(selection === 'coordinator' && !pref.coordinatorId && available.length
            ? [{ key: 'assistant-status', label: '尚未选择助手', detail: '从下面选择一位 Agent。' }]
            : []),
          ...available.map((member) => {
            const selected =
              selection === 'coordinator' ? pref.coordinatorId === member.catId : pref.workerIds.includes(member.catId);
            return {
              key: `${selection}:${member.catId}`,
              label: member.displayName,
              ...(selected
                ? {
                    detail:
                      selection === 'coordinator'
                        ? pref.workerIds.includes(member.catId)
                          ? '当前助手 · 同时执行'
                          : '当前助手'
                        : pref.coordinatorId === member.catId
                          ? '已选执行 · 同时担任助手'
                          : '已选执行',
                  }
                : {}),
              ...(selection === 'coordinator' && selected
                ? {}
                : {
                    actions: [
                      {
                        action: 'choose',
                        label: selection === 'coordinator' ? '设为助手' : selected ? '移出名单' : '加入执行',
                        input: { selection, id: member.catId },
                      },
                    ],
                  }),
            };
          }),
        ],
      },
    };
  }
  async function sourceSelection() {
    const [pref, runtime, works] = await Promise.all([
      preferences(),
      read(host, 'runtime', runtimeSchema),
      records(host, 'work:', workSchema),
    ]);
    return {
      selected: pref.threadIds,
      excluded: [runtime?.mainThreadId, runtime?.coordinationThreadId, ...works.map((work) => work.threadId)]
        .filter((id): id is string => id !== undefined),
    };
  }
  const actions: Record<string, PluginActionHandler> = {
    'superagent.assistant': () => members('coordinator'),
    'superagent.workers': () => members('worker'),
    async 'superagent.settings'() {
      current();
      return { render: 'thread-picker', data: await sourceSelection() };
    },
    async 'superagent.choose'(input, _caller, context) {
      current();
      await owner(context);
      const { input: selection } = z
        .object({
          input: z.discriminatedUnion('selection', [
            z.object({ selection: z.enum(['coordinator', 'worker']), id: z.string().min(1) }).passthrough(),
            z.object({ selection: z.literal('threads'), ids: z.array(z.string().min(1).max(500)).max(5000) }).passthrough(),
          ]),
        })
        .passthrough()
        .parse(input);
      if (selection.selection === 'threads') {
        const [available, state] = await Promise.all([
          host.threads.list({ threadIds: selection.ids }),
          sourceSelection(),
        ]);
        const excluded = new Set(state.excluded);
        const allowed = new Set(
          available.filter((thread) => thread.id !== 'default' && !excluded.has(thread.id)).map((thread) => thread.id),
        );
        if (selection.ids.some((id) => !allowed.has(id))) throw new Error('部分会话已不可用，请重新打开选择器后保存。');
      } else {
        const member = await host.members?.get(selection.id);
        const pref = await preferences();
        const removing = selection.selection === 'worker' && pref.workerIds.includes(selection.id);
        if (!removing && !member?.available) throw new Error('成员不可用');
      }
      await editPreferences(
        host,
        (pref) => {
          if (selection.selection === 'threads') return { ...pref, threadIds: [...new Set(selection.ids)] };
          if (selection.selection === 'coordinator') return { ...pref, coordinatorId: selection.id };
          return {
            ...pref,
            workerIds: pref.workerIds.includes(selection.id)
              ? pref.workerIds.filter((id) => id !== selection.id)
              : [...pref.workerIds, selection.id],
          };
        },
        () => owner(context),
      );
      await refresh();
      return selection.selection === 'threads' ? actions['superagent.settings']({}) : members(selection.selection);
    },
    async 'superagent.enable'(_input, _caller, context) {
      current();
      await owner(context, true);
      const name = await host.config.get('botName');
      const responsibility = await host.config.get('responsibility');
      await editPreferences(
        host,
        (pref) => {
          const next = preferencesSchema.parse({
            ...pref,
            ...(name === undefined ? {} : { name }),
            ...(responsibility === undefined ? {} : { responsibility }),
            enabled: true,
            started: true,
          });
          if (!next.coordinatorId || !next.workerIds.length || !next.threadIds.length || !next.responsibility.trim())
            throw new Error('请先选择助手 Agent、执行 Agent 和监听会话，并保存允许处理的工作范围。');
          return next;
        },
        () => owner(context, true),
      );
      await refresh();
      return { render: 'status', data: '已启用，开始跟进选定会话。' };
    },
    async 'superagent.pause'(_input, _caller, context) {
      current();
      await owner(context);
      await editPreferences(
        host,
        (pref) => ({ ...pref, enabled: false }),
        () => owner(context),
      );
      await refresh();
      return { render: 'status', data: '已暂停新接单与派发，工作和历史保留。' };
    },
    async 'superagent.retry'(_input, _caller, context) {
      current();
      await owner(context, true);
      const failed = (await queued(host, 'inbox', 'inbox:', inboxSchema)).filter((entry) => entry.phase === 'failed');
      if (!failed.length) throw new Error('没有已结束且待重试的判断；运行中的调用不会重复派发。');
      for (const entry of failed) {
        await host.storage.set(`inbox:${entry.delivery.deliveryId}`, {
          ...entry,
          phase: 'pending',
          attempt: entry.attempt + 1,
        });
        await editQueue(host, 'inbox', entry.delivery.deliveryId, true);
      }
      return { render: 'status', data: '已保留原事件并安排重新判断。' };
    },
  };
  return actions;
}
