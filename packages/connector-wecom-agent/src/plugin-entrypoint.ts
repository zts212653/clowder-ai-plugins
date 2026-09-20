import { definePlugin, definePluginModule, requireConnectorOutboundDelivery } from '@clowder-ai/plugin-sdk';

import { WeComAgentAdapter } from './WeComAgentAdapter.js';
import {
  createWeComAgentConnectorRuntime,
  requireWeComAgentWebhookInput,
  type WeComAgentConnectorRuntime,
  type WeComAgentConnectorRuntimeOptions,
} from './runtime.js';

type RuntimeFactory = (
  options: WeComAgentConnectorRuntimeOptions<WeComAgentAdapter>,
) => WeComAgentConnectorRuntime<WeComAgentAdapter>;

export function createWeComAgentPluginModule(createRuntime: RuntimeFactory = createWeComAgentConnectorRuntime) {
  return definePluginModule((manifest) => definePlugin({
    manifest,
    activate: {
      'wecom-agent-messaging': async (context) => {
        const [corpId, agentId, agentSecret, callbackToken, encodingAesKey] = await Promise.all([
          context.config.get('corpId'),
          context.config.get('agentId'),
          context.secrets.get('agentSecret'),
          context.secrets.get('callbackToken'),
          context.secrets.get('encodingAesKey'),
        ]);
        if (typeof corpId !== 'string') throw new TypeError('corpId must be a declared string');
        if (typeof agentId !== 'string') throw new TypeError('agentId must be a declared string');
        const runtime = createRuntime({
          config: { corpId, agentId, agentSecret, callbackToken, encodingAesKey },
          host: { deliver: message => context.connectors.deliver('wecom-agent', message) },
          logger: context.logger,
        });
        await runtime.start();
        return {
          actions: {
            'wecom-agent.outbound': async (candidate) => {
              const input = requireConnectorOutboundDelivery(candidate);
              await runtime.outbound.sendFormattedReply(input.externalConversationId, {
                header: input.presentation.header,
                body: input.presentation.body,
                origin: input.presentation.origin === 'callback' ? 'callback' : 'direct',
                ...(input.presentation.subtitle === undefined ? {} : { subtitle: input.presentation.subtitle }),
                ...(input.presentation.footer === undefined ? {} : { footer: input.presentation.footer }),
              });
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
            'wecom-agent.webhook': candidate => runtime.handleWebhook(requireWeComAgentWebhookInput(candidate)),
          },
          dispose: () => runtime.stop(),
        };
      },
    },
  }));
}

export default createWeComAgentPluginModule();
