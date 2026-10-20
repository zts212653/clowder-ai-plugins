import type {definePluginModule} from '@clowder-ai/plugin-sdk';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';

export type SettingsHost = Pick<ModulePluginHostShape, 'config' | 'secrets' | 'storage' | 'log'>;
export interface SettingsDefinition {
  readonly actions: Readonly<Record<string, (params: unknown) => Promise<unknown>>>;
  dispose?(): void | Promise<void>;
}
export interface SettingsEntrypoint {
  create(manifest: unknown): ReturnType<ReturnType<typeof definePluginModule>['create']> & { settings(host: SettingsHost): SettingsDefinition };
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
      if (!botId || !secret) return { render: 'status', data: { status: 'error', message: '未填写 Bot ID / Bot Secret — 在面板里填好，直接点测试并连接' }, advance: false };
      const result = await validate(botId, secret);
      if (!result.valid) return { render: 'status', data: { status: 'error', message: result.error ?? 'credentials rejected by provider' }, advance: false };
      return { render: 'status', data: { status: 'confirmed' }, label: '已连接', targetValues: { botId, botSecret: secret } };
    },
    'wecom-bot.disconnect': async () => ({ render: 'status', data: { status: 'disconnected' }, label: '已断开', targetValues: { botId: '', botSecret: '' } }),
  } };
}
