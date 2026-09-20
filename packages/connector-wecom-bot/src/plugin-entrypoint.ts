import {
  definePlugin,
  definePluginModule,
  requireConnectorOutboundDelivery,
} from '@clowder-ai/plugin-sdk';

import { WeComBotAdapter } from './WeComBotAdapter.js';
import {
  createWeComBotConnectorRuntime,
  type WeComBotConnectorRuntime,
  type WeComBotConnectorRuntimeOptions,
} from './runtime.js';

type RuntimeFactory = (
  options: WeComBotConnectorRuntimeOptions<WeComBotAdapter>,
) => WeComBotConnectorRuntime<WeComBotAdapter>;

export function createWeComBotPluginModule(createRuntime: RuntimeFactory = createWeComBotConnectorRuntime) {
  return definePluginModule((manifest) => definePlugin({
    manifest,
    activate: {
      'wecom-bot-messaging': async (context) => {
        const botId = await context.config.get('botId');
        if (typeof botId !== 'string') throw new TypeError('botId must be a declared string');
        const botSecret = await context.secrets.get('botSecret');
        const runtime = createRuntime({
          config: { botId, botSecret },
          host: { deliver: message => context.connectors.deliver('wecom-bot', message) },
          logger: context.logger,
        });
        await runtime.start();
        return {
          actions: {
            'wecom-bot.outbound': async (candidate) => {
              const input = requireConnectorOutboundDelivery(candidate);
              await runtime.outbound.sendFormattedReply(
                input.externalConversationId,
                {
                  header: input.presentation.header,
                  body: input.presentation.body,
                  origin: input.presentation.origin === 'callback' ? 'callback' : 'direct',
                  ...(input.presentation.subtitle === undefined ? {} : { subtitle: input.presentation.subtitle }),
                  ...(input.presentation.footer === undefined ? {} : { footer: input.presentation.footer }),
                },
                input.metadata,
              );
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

export default createWeComBotPluginModule();
