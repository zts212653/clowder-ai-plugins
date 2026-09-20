import { definePlugin, definePluginModule, requireConnectorOutboundDelivery } from '@clowder-ai/plugin-sdk';

import { FeishuAdapter } from './FeishuAdapter.js';
import {
  createFeishuConnectorRuntime,
  requireFeishuWebhookInput,
  type FeishuConnectorRuntime,
  type FeishuConnectorRuntimeOptions,
} from './runtime.js';

type RuntimeFactory = (
  options: FeishuConnectorRuntimeOptions<FeishuAdapter>,
) => FeishuConnectorRuntime<FeishuAdapter>;

function optionalString(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError(`${key} must be a declared string`);
  return value;
}

export function createFeishuPluginModule(createRuntime: RuntimeFactory = createFeishuConnectorRuntime) {
  return definePluginModule((manifest) => definePlugin({
    manifest,
    activate: {
      'feishu-messaging': async (context) => {
        const [appId, appSecret, modeValue, verificationToken, groupBotMentionsJson] = await Promise.all([
          context.config.get('appId'),
          context.secrets.get('appSecret'),
          context.config.get('connectionMode'),
          context.secrets.get('verificationToken'),
          context.config.get('groupBotMentionsJson'),
        ]);
        if (typeof appId !== 'string') throw new TypeError('appId must be a declared string');
        const mode = modeValue === undefined ? 'webhook' : modeValue;
        if (mode !== 'webhook' && mode !== 'websocket') throw new TypeError('connectionMode must be webhook or websocket');
        const runtime = createRuntime({
          config: {
            appId,
            appSecret,
            connectionMode: mode,
            ...(verificationToken === '' ? {} : { verificationToken }),
            ...(optionalString(groupBotMentionsJson, 'groupBotMentionsJson') === undefined
              ? {} : { groupBotMentionsJson: groupBotMentionsJson as string }),
          },
          host: { deliver: message => context.connectors.deliver('feishu', message) },
          logger: context.logger,
        });
        await runtime.start();
        return {
          actions: {
            'feishu.outbound': async (candidate) => {
              const input = requireConnectorOutboundDelivery(candidate);
              await runtime.outbound.sendFormattedReply(input.externalConversationId, {
                header: input.presentation.header,
                subtitle: input.presentation.subtitle ?? '',
                body: input.presentation.body,
                footer: input.presentation.footer ?? '',
                origin: input.presentation.origin === 'callback' ? 'callback' : 'agent',
                ...(input.presentation.cardActions === undefined
                  ? {} : { cardActions: input.presentation.cardActions.map(action => ({ label: action.label, value: { ...action.value } })) }),
              }, input.metadata);
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
            'feishu.webhook': candidate => runtime.handleWebhook(requireFeishuWebhookInput(candidate)),
          },
          dispose: () => runtime.stop(),
        };
      },
    },
  }));
}

export default createFeishuPluginModule();
