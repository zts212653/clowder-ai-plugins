import type { ModulePluginHostShape, PluginModuleDefinition, PluginModuleEntrypoint } from '@clowder-ai/plugin-sdk';
import type { FeishuQrBindClient } from './FeishuQrBindClient.js';

export type SettingsHost = Pick<ModulePluginHostShape, 'config' | 'secrets' | 'storage' | 'log'>;
export interface SettingsDefinition {
  readonly actions: Readonly<Record<string, (params: unknown) => Promise<unknown>>>;
  dispose?(): void | Promise<void>;
}
export interface SettingsEntrypoint extends PluginModuleEntrypoint {
  create(manifest: unknown): PluginModuleDefinition & { settings(host: SettingsHost): SettingsDefinition };
}


export function createFeishuSettings(client: FeishuQrBindClient): SettingsDefinition {
  return { actions: {
    'feishu.qr-generate': async () => {
      const result = await client.create();
      return { render: 'img', data: { url: result.qrUrl, qrPayload: result.qrPayload } };
    },
    'feishu.qr-status': async params => {
      const qrPayload = (params as { operationState?: { lastResult?: { data?: { qrPayload?: string } } } })?.operationState?.lastResult?.data?.qrPayload;
      if (!qrPayload) return { render: 'status', data: { status: 'error', message: 'No QR payload' }, advance: false };
      const status = await client.poll(qrPayload);
      if (status.status === 'confirmed' && status.appId && status.appSecret) return {
        render: 'status', data: { status: 'confirmed' }, label: '已授权',
        targetValues: { appId: status.appId, appSecret: status.appSecret, connectionMode: 'websocket' },
      };
      return { render: 'polling', data: { status: status.status, qrPayload }, advance: false };
    },
    'feishu.disconnect': async () => ({ render: 'status', data: { status: 'disconnected' }, label: '已断开', targetValues: { appId: '', appSecret: '' } }),
  } };
}
