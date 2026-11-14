import { readFile } from 'node:fs/promises';
import { DelegationRuntime } from './runtime.mjs';

function ownerSettings(host, native, owner) {
  if (native !== undefined || owner?.kind !== 'owner-operation' || owner.pluginInstanceId !== host.pluginInstanceId || typeof owner.assertCurrent !== 'function')
    throw Error('请由本人通过插件设置操作');
}
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
    const health = () => ({ ok: Boolean(runtime?.model.available()), message: runtime ? '插件已加载；账号连接、会话授权与真实收发验证请分别在控制台检查。' : '请先启用插件；启用不会启动第三方账号组件或开启任何代聊。' });
    const settings = host => ({ actions: {
      'wechat.health': health,
      'wechat.status': async (_input, native, owner) => {
        ownerSettings(host, native, owner); await owner.assertCurrent();
        const state = runtime ? await runtime.status() : null;
        return { render: 'text', data: !state ? '业务未启用。启用后打开微信代聊控制台完成连接。' :
          `连接组件：${state.runtime === 'running' ? '运行中' : '未准备'}；账号：${state.account?.connected ? '已连接' : '尚未确认'}；开启代聊：${state.policies.filter(p => p.mode === 'active').length} 个会话。` };
      },
      'wechat.pause': async (_input, native, owner) => {
        ownerSettings(host, native, owner); await owner.assertCurrent();
        if (runtime) await runtime.service.takeover(null);
        return { render: 'text', data: '本地代聊已停止。已移交但取消未确认的消息仍可能发出，请在控制台逐条核对。' };
      },
    } });
    return {
      settings,
      async start(host) {
        runtime = await DelegationRuntime.open(host);
        const current = runtime;
        return {
          actions: {
            ...settings(host).actions,
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
          async preStop() { await current.service.takeover(null); },
          async stop() { await current.stop(); if (runtime === current) runtime = undefined; },
        };
      },
    };
  },
};
