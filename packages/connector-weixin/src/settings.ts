import type { ModulePluginHostShape, PluginModuleDefinition, PluginModuleEntrypoint } from '@clowder-ai/plugin-sdk';
import { WeixinAdapter } from './WeixinAdapter.js';

export type SettingsHost = Pick<ModulePluginHostShape, 'config' | 'secrets' | 'storage' | 'log'>;
export interface SettingsDefinition {
  readonly actions: Readonly<Record<string, (params: unknown) => Promise<unknown>>>;
  dispose?(): void | Promise<void>;
}
export interface SettingsEntrypoint extends PluginModuleEntrypoint {
  create(manifest: unknown): PluginModuleDefinition & { settings(host: SettingsHost): SettingsDefinition };
}


function payload(params: unknown): string | undefined {
  return (params as { operationState?: { lastResult?: { data?: { qrPayload?: string } } } })?.operationState?.lastResult?.data?.qrPayload;
}

// Same static provider calls and persisted lastResult as the original handleAction.
export function createWeixinSettings(host: SettingsHost): SettingsDefinition {
  return { actions: {
    'weixin.qr-generate': async () => {
      const result = await WeixinAdapter.fetchQrCode();
      const QRCode = await import('qrcode');
      return { render: 'img', data: { url: await QRCode.toDataURL(result.qrUrl, { width: 384, margin: 2 }), qrPayload: result.qrPayload } };
    },
    'weixin.qr-status': async params => {
      const qrPayload = payload(params);
      if (!qrPayload) return { render: 'status', data: { status: 'error', message: 'No QR payload — generate first' }, advance: false };
      const status = await WeixinAdapter.pollQrCodeStatus(qrPayload);
      if (status.status === 'confirmed' && status.botToken) return {
        render: 'status', data: { status: 'confirmed' }, label: '已连接', targetValues: { botToken: status.botToken },
      };
      return { render: 'polling', data: { status: status.status, qrPayload }, advance: false };
    },
    'weixin.disconnect': async () => {
      await host.storage.set('provider-session', null);
      return { render: 'status', data: { status: 'disconnected' }, label: '已断开', targetValues: { botToken: '' } };
    },
  } };
}
