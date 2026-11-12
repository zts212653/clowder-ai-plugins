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

const directory = z.object({ before: z.object({ lastActiveAt: z.number(), id: z.string() }).optional() }).strict();

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
  const actions: Record<string, PluginActionHandler> = {
    'superagent.assistant': () => members('coordinator'),
    'superagent.workers': () => members('worker'),
    async 'superagent.settings'() {
      current();
      const pref = await preferences();
      const page = (await read(host, 'directory-page', directory)) ?? {};
      const [threads, selected, runtime, works] = await Promise.all([
        host.threads.list({ limit: 50, before: page.before }),
        Promise.all(pref.threadIds.map((id) => host.threads.get(id))),
        read(host, 'runtime', runtimeSchema),
        records(host, 'work:', workSchema),
      ]);
      const ownThreads = new Set([runtime?.mainThreadId, ...works.map((work) => work.threadId)]);
      const visible = [
        ...selected.filter((thread) => thread !== null),
        ...threads.filter((thread) => !pref.threadIds.includes(thread.id)),
      ].filter((thread) => !ownThreads.has(thread.id));
      const last = threads.at(-1);
      return {
        render: 'rows',
        data: {
          empty: '还没有可跟进的会话。',
          rows: [
            ...visible.map((thread) => ({
              key: thread.id,
              label: thread.title ?? '未命名会话',
              ...(pref.threadIds.includes(thread.id)
                ? { detail: pref.enabled ? '跟进中' : pref.started ? '已选，暂停中' : '已选，开始跟进后生效' }
                : {}),
              actions: [
                {
                  action: 'choose',
                  label: pref.threadIds.includes(thread.id) ? '移除' : '选择',
                  input: { selection: 'thread', id: thread.id },
                },
              ],
            })),
            ...(last && threads.length === 50
              ? [
                  {
                    key: 'more',
                    label: '更早的会话',
                    actions: [
                      {
                        action: 'page',
                        label: '继续选择',
                        input: {
                          lastActiveAt: last.lastActiveAt,
                          id: last.id,
                        },
                      },
                    ],
                  },
                ]
              : []),
            ...(page.before
              ? [
                  {
                    key: 'recent',
                    label: '最近的会话',
                    actions: [{ action: 'page', label: '返回最近', input: { recent: true } }],
                  },
                ]
              : []),
          ],
        },
      };
    },
    async 'superagent.page'(input, _caller, context) {
      current();
      await owner(context);
      const { input: page } = z
        .object({
          input: z.union([
            z.object({ lastActiveAt: z.number(), id: z.string() }).transform((before) => ({ before })),
            z.object({ recent: z.literal(true) }).transform(() => ({})),
          ]),
        })
        .passthrough()
        .parse(input);
      await host.storage.set('directory-page', page);
      return actions['superagent.settings']({});
    },
    async 'superagent.choose'(input, _caller, context) {
      current();
      await owner(context);
      const { input: selection } = z
        .object({
          input: z
            .object({
              selection: z.enum(['coordinator', 'worker', 'thread']),
              id: z.string().min(1),
            })
            .passthrough(),
        })
        .passthrough()
        .parse(input);
      if (selection.selection === 'thread') {
        if (!(await host.threads.get(selection.id))) throw new Error('会话不可用');
      } else {
        const member = await host.members?.get(selection.id);
        const pref = await preferences();
        const removing = selection.selection === 'worker' && pref.workerIds.includes(selection.id);
        if (!removing && !member?.available) throw new Error('成员不可用');
      }
      await editPreferences(
        host,
        (pref) => {
          if (selection.selection === 'coordinator') return { ...pref, coordinatorId: selection.id };
          const key = selection.selection === 'thread' ? 'threadIds' : 'workerIds';
          return {
            ...pref,
            [key]: pref[key].includes(selection.id)
              ? pref[key].filter((id) => id !== selection.id)
              : [...pref[key], selection.id],
          };
        },
        () => owner(context),
      );
      await refresh();
      return selection.selection === 'thread' ? actions['superagent.settings']({}) : members(selection.selection);
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
