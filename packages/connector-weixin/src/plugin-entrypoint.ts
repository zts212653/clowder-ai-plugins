import {
  definePlugin,
  definePluginModule,
  requireConnectorOutboundDelivery,
  type FeatureContext,
} from '@clowder-ai/plugin-sdk';

import {
  createWeixinConnectorRuntime,
  type WeixinConnectorRuntime,
  type WeixinConnectorRuntimeOptions,
} from './runtime.js';
import { WeixinAdapter, type WeixinSessionState, type WeixinSessionStateStore } from './WeixinAdapter.js';

type RuntimeFactory = (
  options: WeixinConnectorRuntimeOptions<WeixinAdapter>,
) => WeixinConnectorRuntime<WeixinAdapter>;

function optionalString(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError(`${key} must be a declared string`);
  return value;
}

function optionalBoolean(value: unknown, key: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new TypeError(`${key} must be a declared boolean`);
  return value;
}

function sessionStatePort(context: FeatureContext): WeixinSessionStateStore {
  return {
    async load() {
      const value = await context.state.get('provider-session');
      return value !== null && typeof value === 'object' ? value as WeixinSessionState : null;
    },
    save: value => context.state.set('provider-session', value),
    clear: () => context.state.set('provider-session', null),
  };
}

export function createWeixinPluginModule(createRuntime: RuntimeFactory = createWeixinConnectorRuntime) {
  return definePluginModule((manifest) => definePlugin({
    manifest,
    activate: {
      'weixin-messaging': async (context) => {
        const [botToken, voiceItemMode, unsafeModesValue, captureVoiceValue, apiBaseUrlValue] = await Promise.all([
          context.secrets.get('botToken'),
          context.config.get('voiceItemMode'),
          context.config.get('enableUnsafeVoiceModes'),
          context.config.get('captureInboundVoiceMedia'),
          context.config.get('apiBaseUrl'),
        ]);
        const mode = optionalString(voiceItemMode, 'voiceItemMode');
        if (mode !== undefined && !['minimal', 'playtime', 'playtime-sec', 'playtime-encode', 'metadata'].includes(mode)) {
          throw new TypeError('voiceItemMode is not declared by the manifest');
        }
        const unsafeModes = optionalBoolean(unsafeModesValue, 'enableUnsafeVoiceModes');
        const captureVoice = optionalBoolean(captureVoiceValue, 'captureInboundVoiceMedia');
        const apiBaseUrl = optionalString(apiBaseUrlValue, 'apiBaseUrl');
        const runtime = createRuntime({
          config: {
            botToken,
            ...(mode === undefined ? {} : { voiceItemMode: mode as 'minimal' | 'playtime' | 'playtime-sec' | 'playtime-encode' | 'metadata' }),
            ...(unsafeModes === undefined ? {} : { enableUnsafeVoiceModes: unsafeModes }),
            ...(captureVoice === undefined ? {} : { captureInboundVoiceMedia: captureVoice }),
            ...(apiBaseUrl === undefined ? {} : { apiBaseUrl }),
          },
          state: sessionStatePort(context),
          host: { deliver: message => context.connectors.deliver('weixin', message) },
          logger: context.logger,
        });
        await runtime.start();
        return {
          actions: {
            'weixin.outbound': async (candidate) => {
              const input = requireConnectorOutboundDelivery(candidate);
              const text = [input.presentation.header, input.presentation.subtitle, input.presentation.body, input.presentation.footer]
                .filter((value): value is string => value !== undefined && value.length > 0)
                .join('\n\n');
              await runtime.outbound.sendReply(input.externalConversationId, text);
              for (const media of input.media ?? []) {
                if (media.type === 'video') {
                  await runtime.outbound.sendReply(input.externalConversationId, `🎬 ${media.reference}`);
                } else {
                  await runtime.outbound.sendMedia(input.externalConversationId, {
                    type: media.type,
                    url: media.reference,
                    ...(media.fileName === undefined ? {} : { fileName: media.fileName }),
                  });
                }
              }
            },
          },
          dispose: () => runtime.stop(),
        };
      },
    },
  }));
}

export default createWeixinPluginModule();
