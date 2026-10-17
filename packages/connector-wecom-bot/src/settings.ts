import type { ModulePluginHostShape, PluginModuleDefinition, PluginModuleEntrypoint } from '@clowder-ai/plugin-sdk';

export type SettingsHost = Pick<ModulePluginHostShape, 'config' | 'secrets' | 'storage' | 'log'>;
export interface SettingsDefinition {
  readonly actions: Readonly<Record<string, (params: unknown) => Promise<unknown>>>;
  dispose?(): void | Promise<void>;
}
export interface SettingsEntrypoint extends PluginModuleEntrypoint {
  create(manifest: unknown): PluginModuleDefinition & { settings(host: SettingsHost): SettingsDefinition };
}

export type ValidateCredentialsFn = (botId: string, secret: string) => Promise<{ valid: boolean; error?: string }>;

export function createWeComSettings(host: SettingsHost, validate: ValidateCredentialsFn): SettingsDefinition {
  return { actions: {
    'wecom-bot.validate': async params => {
      const input = (params as { input?: Record<string, unknown> })?.input ?? {};
      const idValue = input.botId ?? await host.config.get('botId');
      const secretValue = input.botSecret ?? await host.secrets.get('botSecret');
      const botId = typeof idValue === 'string' ? idValue.trim() : '';
      const secret = typeof secretValue === 'string' ? secretValue.trim() : '';
      if (!botId || !secret) return { render: 'status', data: { status: 'error', message: '请先保存 Bot ID 和 Bot Secret' }, advance: false };
      const result = await validate(botId, secret);
      if (!result.valid) return { render: 'status', data: { status: 'error', message: result.error ?? '凭据验证失败' }, advance: false };
      return { render: 'status', data: { status: 'connected' }, label: '已连接', targetValues: { botId, botSecret: secret } };
    },
    'wecom-bot.disconnect': async () => ({ render: 'status', data: { status: 'disconnected' }, label: '已断开', targetValues: { botId: '', botSecret: '' } }),
  } };
}
