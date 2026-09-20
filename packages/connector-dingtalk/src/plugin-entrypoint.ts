import {
  definePlugin,
  definePluginModule,
  requireConnectorOutboundDelivery,
} from '@clowder-ai/plugin-sdk';

import {
  createDingTalkConnectorRuntime,
  type DingTalkConnectorRuntime,
  type DingTalkConnectorRuntimeOptions,
} from './runtime.js';
import { DingTalkAdapter } from './DingTalkAdapter.js';

type DingTalkRuntimeFactory = (
  options: DingTalkConnectorRuntimeOptions<DingTalkAdapter>,
) => DingTalkConnectorRuntime<DingTalkAdapter>;

export function createDingTalkPluginModule(
  createRuntime: DingTalkRuntimeFactory = createDingTalkConnectorRuntime,
) {
  return definePluginModule((manifest) => definePlugin({
    manifest,
    activate: {
      'dingtalk-messaging': async (context) => {
        const appKey = await context.config.get('appKey');
        const appSecret = await context.secrets.get('appSecret');
        if (typeof appKey !== 'string') throw new TypeError('appKey must be a declared string');
        const runtime = createRuntime({
          config: { appKey, appSecret },
          host: { deliver: (message) => context.connectors.deliver('dingtalk', message) },
          logger: context.logger,
        });
        await runtime.start();
        return {
          actions: {
            'dingtalk.outbound': async (candidate) => {
              const input = requireConnectorOutboundDelivery(candidate);
              await runtime.outbound.sendFormattedReply(
                input.externalConversationId,
                {
                  ...input.presentation,
                  origin: input.presentation.origin === 'callback' ? 'callback' : 'direct',
                },
                input.metadata,
              );
              for (const media of input.media ?? []) {
                if (media.type === 'video') {
                  await runtime.outbound.sendReply(input.externalConversationId, `🎬 ${media.reference}`);
                  continue;
                }
                await runtime.outbound.sendMedia(input.externalConversationId, {
                  type: media.type,
                  url: media.reference,
                  ...(media.fileName === undefined ? {} : { fileName: media.fileName }),
                });
              }
            },
          },
          dispose: () => runtime.stop(),
        };
      },
    },
  }));
}

export default createDingTalkPluginModule();
