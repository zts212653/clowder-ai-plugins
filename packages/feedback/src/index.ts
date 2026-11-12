import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { FeedbackService, RevisionConflictError } from './service.js';
import { parseProfiles, record } from './config.js';
import { sanitize } from './sanitize.js';
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
              const request = record(record(input).request);
              if (request.method !== 'GET' || request.path !== 'panel') throw new Error('面板资源仅支持声明的 GET 路由');
              return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: html };
            },
            'feedback.http': async (input: unknown, _native?: unknown, context?: OwnerContext) => {
              const request = record(record(input).request);
              if (request.method !== 'POST' || request.path !== 'feedback') throw new Error('反馈 HTTP 路由无效');
              try {
                const value = await service.dispatch(request.body, context);
                return {
                  status: 200,
                  headers: { 'content-type': 'application/json; charset=utf-8' },
                  // Standard HTTP streaming preserves reports with large retained screenshots.
                  body: Readable.from([JSON.stringify(value ?? null)]),
                };
              } catch (error) {
                return { status: 409, headers: { 'content-type': 'application/json; charset=utf-8' },
                  body: { error: sanitize(error instanceof Error ? error.message : '反馈操作未完成').slice(0, 512),
                    ...(error instanceof RevisionConflictError ? {code:error.code} : {}) } };
              }
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
