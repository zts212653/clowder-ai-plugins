import { readFile } from 'node:fs/promises';
import { FeedbackService } from './service.js';
import { parseProfiles } from './config.js';
import type { Host, OwnerContext } from './types.js';

/** Standard builtin module entrypoint; no native tool or anonymous publish surface is declared. */
export default {
  create() {
    const check = async (host: Pick<Host, 'config'>) => {
      parseProfiles(await host.config.get('destinations'));
      return { ok: true, message: '目标配置有效。启用后从左栏底部打开问题反馈；自动提交会在确认前核验身份与附件通路。' };
    };
    return {
      settings: (host: Pick<Host, 'config'>) => ({ actions: { 'feedback.check': () => check(host) } }),
      async start(host: Host) {
        const service = new FeedbackService(host);
        const html = await readFile(new URL('./panel.html', import.meta.url), 'utf8');
        return {
          actions: {
            'feedback.panel': async (input: unknown, _native?: unknown, context?: OwnerContext) => {
              if (context?.kind !== 'owner-http-request' || context.pluginInstanceId !== host.pluginInstanceId) throw new Error('请通过左栏反馈入口打开面板');
              await context.assertCurrent();
              if (input && typeof input === 'object' && 'op' in input && input.op === 'open') return { kind: 'plugin-panel', version: 1, html } satisfies import('@clowder-ai/plugin-sdk').PluginUiPanel;
              return service.dispatch(input, context);
            },
            'feedback.check': () => check(host),
            'feedback.delivery': (input: unknown) => service.receiveDelivery(input),
          },
          stop() {},
        };
      },
    };
  },
};
