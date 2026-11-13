import type { PluginActionHandler, PluginHostActionContext } from '@clowder-ai/plugin-sdk';
import type { SuperagentHost } from './runtime.js';
import { editPreferences, editQueue, inboxSchema, type Preferences, preferencesSchema, queued } from './state.js';

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
  const actions: Record<string, PluginActionHandler> = {
    async 'superagent.enable'(_input, _caller, context) {
      current();
      await owner(context, true);
      const name = await host.config.get('botName');
      const responsibility = await host.config.get('responsibility');
      const scope = await preferences();
      const missing = '请先选择助手 Agent、执行 Agent 和监听会话，并保存允许处理的工作范围。';
      if (!scope.coordinatorId || !scope.workerIds.length || !scope.threadIds.length) throw new Error(missing);
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
          if (!next.responsibility.trim()) throw new Error(missing);
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
