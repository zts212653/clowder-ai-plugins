import type {definePluginModule} from '@clowder-ai/plugin-sdk';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import { WeixinAdapter } from './WeixinAdapter.js';

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


const QR_SESSION_KEY = 'weixin.qr-session.v1';

export function createWeixinSettings(host: SettingsHost): SettingsDefinition {
  return { actions: {
    'weixin.qr-generate': async (_params, _action, call) => {
      await current(call);
      const result = await WeixinAdapter.fetchQrCode();
      const QRCode = await import('qrcode');
      const url = await QRCode.toDataURL(result.qrUrl, { width: 384, margin: 2 });
      await current(call);
      await host.storage.set(QR_SESSION_KEY, {qrPayload: result.qrPayload});
      return { render: 'img', data: { url } };
    },
    'weixin.qr-status': async (_params, _action, call) => {
      await current(call);
      const value = (await host.storage.get(QR_SESSION_KEY))?.value as {qrPayload?: unknown} | undefined;
      const qrPayload = typeof value?.qrPayload === 'string' ? value.qrPayload : undefined;
      if (!qrPayload) return { render: 'polling', data: { status: 'error', message: 'No QR payload — generate first' }, advance: false };
      const status = await WeixinAdapter.pollQrCodeStatus(qrPayload);
      await current(call);
      if (status.status === 'confirmed') {
        if (!status.botToken) return {render:'polling',data:{status:'error',message:'confirmed but no bot_token'},advance:false};
        await host.storage.set(QR_SESSION_KEY,null);
        return {render:'status',data:{status:'confirmed'},label:'已连接',targetValues:{botToken:status.botToken}};
      }
      return { render: 'polling', data: { status: status.status, ...('message' in status ? {message:status.message} : {}) }, advance: false };
    },
    'weixin.disconnect': async (_params, _action, call) => {
      await current(call);
      await host.storage.set('provider-session', null);
      await host.storage.set(QR_SESSION_KEY, null);
      return { render: 'status', data: { status: 'disconnected' }, label: '已断开', targetValues: { botToken: '' } };
    },
  } };
}
