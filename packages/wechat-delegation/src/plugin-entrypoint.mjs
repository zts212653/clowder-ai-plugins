import { readFile } from 'node:fs/promises';
import { DelegationRuntime } from './runtime.mjs';

async function ownerHttp(host, input, native, owner, method, path) {
  const request = input?.request;
  if (native !== undefined || owner?.kind !== 'owner-http-request' || owner.pluginInstanceId !== host.pluginInstanceId ||
      owner.operation !== (method === 'GET' ? 'read' : 'write') || !owner.requestIdentity ||
      request?.method !== method || request.path !== path || owner.requestIdentity.method !== method || owner.requestIdentity.path !== path ||
      request.principal && request.principal.id !== owner.userId || typeof owner.assertCurrent !== 'function') throw Error('需要当前插件面板的本人登录会话');
  owner.signal.throwIfAborted(); await owner.assertCurrent();
  return request;
}
const json = (status, body) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body });

export default {
  create() {
    let runtime;
    return {
      async start(host) {
        runtime = await DelegationRuntime.open(host);
        const current = runtime;
        return {
          actions: {
            'wechat.panel': async (input, native, owner) => {
              await ownerHttp(host, input, native, owner, 'GET', 'panel');
              const body = await readFile(new URL('./panel.html', import.meta.url), 'utf8');
              await owner.assertCurrent();
              return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body };
            },
            'wechat.control': async (input, native, owner) => {
              const request = await ownerHttp(host, input, native, owner, 'POST', 'control');
              try { return json(200, await current.dispatch(request.body, owner)); }
              catch (error) { return json(409, { error: error instanceof Error ? error.message.slice(0, 300) : '操作未完成，请核对当前状态。' }); }
            },
            'wechat.ownerDelivery': input => current.ownerDelivery(input),
          },
          deliver: input => current.ownerDelivery(input),
          async configRefresh() { await current.service.takeover(null); await current.supervisor.stop(); },
          async preStop() { await current.preStop(); },
          async stop() { await current.stop(); if (runtime === current) runtime = undefined; },
        };
      },
    };
  },
};
