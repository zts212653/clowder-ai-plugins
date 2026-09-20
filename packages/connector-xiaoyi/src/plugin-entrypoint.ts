import {
  definePlugin,
  definePluginModule,
  requireConnectorOutboundDelivery,
} from '@clowder-ai/plugin-sdk';

import {
  createXiaoyiConnectorRuntime,
  type XiaoyiConnectorRuntime,
  type XiaoyiConnectorRuntimeOptions,
} from './runtime.js';
import { XiaoyiAdapter } from './XiaoyiAdapter.js';

type RuntimeFactory = (
  options: XiaoyiConnectorRuntimeOptions<XiaoyiAdapter>,
) => XiaoyiConnectorRuntime<XiaoyiAdapter>;

export function createXiaoyiPluginModule(createRuntime: RuntimeFactory = createXiaoyiConnectorRuntime) {
  return definePluginModule((manifest) => definePlugin({
    manifest,
    activate: {
      'xiaoyi-messaging': async (context) => {
        const [accessKey, secretKey, agentId] = await Promise.all([
          context.config.get('accessKey'),
          context.secrets.get('secretKey'),
          context.config.get('agentId'),
        ]);
        if (typeof accessKey !== 'string') throw new TypeError('accessKey must be a declared string');
        if (typeof agentId !== 'string') throw new TypeError('agentId must be a declared string');
        const runtime = createRuntime({
          config: { accessKey, secretKey, agentId },
          host: { deliver: message => context.connectors.deliver('xiaoyi', message) },
          logger: context.logger,
        });
        await runtime.start();
        return {
          actions: {
            'xiaoyi.outbound': async (candidate) => {
              const input = requireConnectorOutboundDelivery(candidate);
              const text = [input.presentation.header, input.presentation.subtitle, input.presentation.body, input.presentation.footer]
                .filter((value): value is string => value !== undefined && value.length > 0)
                .join('\n\n');
              await runtime.outbound.sendReply(input.externalConversationId, text);
              for (const media of input.media ?? []) {
                await runtime.outbound.sendReply(input.externalConversationId, `📎 ${media.reference}`);
              }
              await runtime.outbound.onDeliveryBatchDone(input.externalConversationId, true);
            },
          },
          dispose: () => runtime.stop(),
        };
      },
    },
  }));
}

export default createXiaoyiPluginModule();
