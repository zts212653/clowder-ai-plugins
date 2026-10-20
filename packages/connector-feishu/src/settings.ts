import type {definePluginModule} from '@clowder-ai/plugin-sdk';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import type { FeishuQrBindClient } from './FeishuQrBindClient.js';

export type SettingsHost = Pick<ModulePluginHostShape, 'config' | 'secrets' | 'storage' | 'log'>;
interface SettingsCall { readonly signal?: AbortSignal; assertCurrent(): void | Promise<void>; }
const current = async (call?: SettingsCall) => {call?.signal?.throwIfAborted();await call?.assertCurrent();call?.signal?.throwIfAborted();};
export interface SettingsDefinition {
  readonly actions: Readonly<Record<string, (params: unknown, action?: unknown, call?: SettingsCall) => Promise<unknown>>>;
  dispose?(): void | Promise<void>;
}
export interface SettingsEntrypoint {
  create(manifest: unknown): ReturnType<ReturnType<typeof definePluginModule>['create']> & { settings(host: SettingsHost): SettingsDefinition };
}


const QR_SESSION_KEY = 'feishu.qr-session.v1';
export function createFeishuSettings(host: SettingsHost, client: FeishuQrBindClient): SettingsDefinition {
  return { actions: {
    'feishu.qr-generate': async (_params, _action, call) => {
      await current(call);
      const result = await client.create();
      await current(call);
      await host.storage.set(QR_SESSION_KEY, {qrPayload: result.qrPayload});
      return { render: 'img', data: { url: result.qrUrl } };
    },
    'feishu.qr-status': async (_params, _action, call) => {
      await current(call);
      const value = (await host.storage.get(QR_SESSION_KEY))?.value as {qrPayload?: unknown} | undefined;
      const qrPayload = typeof value?.qrPayload === 'string' ? value.qrPayload : undefined;
      if (!qrPayload) return { render: 'polling', data: { status: 'error', message: 'No QR payload — generate first' }, advance: false };
      const status = await client.poll(qrPayload);
      await current(call);
      if (status.status === 'confirmed') {
        if (!status.appId || !status.appSecret) return {render:'polling',data:{status:'error',message:'confirmed but no credentials'},advance:false};
        await host.storage.set(QR_SESSION_KEY,null);
        return {render:'status',data:{status:'confirmed'},label:'已授权',targetValues:{appId:status.appId,appSecret:status.appSecret,connectionMode:'websocket'}};
      }
      return { render: 'polling', data: { status: status.status, ...(status.error === undefined ? {} : {message:status.error}) }, advance: false };
    },
    'feishu.disconnect': async (_params, _action, call) => {
      await current(call); await host.storage.set(QR_SESSION_KEY,null); return { render: 'status', data: { status: 'disconnected' }, label: '已断开', targetValues: { appId: '', appSecret: '' } }; },
  } };
}
