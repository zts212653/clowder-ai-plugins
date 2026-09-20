import {
  definePlugin,
  definePluginModule,
  requireConnectorOutboundDelivery,
  type ConnectorOutboundDelivery,
} from '@clowder-ai/plugin-sdk';

import {
  createTelegramConnectorRuntime,
  type TelegramConnectorRuntime,
  type TelegramConnectorRuntimeOptions,
} from './runtime.js';
import { TelegramAdapter } from './TelegramAdapter.js';

type TelegramRuntimeFactory = (
  options: TelegramConnectorRuntimeOptions<TelegramAdapter>,
) => TelegramConnectorRuntime<TelegramAdapter>;

async function deliver(adapter: TelegramAdapter, candidate: unknown): Promise<void> {
  const input: ConnectorOutboundDelivery = requireConnectorOutboundDelivery(candidate);
  const blocks = [...(input.richBlocks ?? [])];
  if (blocks.length > 0) {
    await adapter.sendRichMessage(
      input.externalConversationId,
      input.presentation.body,
      blocks as unknown as Parameters<TelegramAdapter['sendRichMessage']>[2],
      input.presentation.header,
    );
  } else {
    const text = [input.presentation.subtitle, input.presentation.body, input.presentation.footer]
      .filter((value): value is string => value !== undefined && value.length > 0)
      .join('\n\n');
    await adapter.sendReply(input.externalConversationId, text);
  }
  for (const media of input.media ?? []) {
    if (media.type === 'video') {
      await adapter.sendReply(input.externalConversationId, `🎬 ${media.reference}`);
      continue;
    }
    await adapter.sendMedia(input.externalConversationId, {
      type: media.type,
      url: media.reference,
      ...(media.fileName === undefined ? {} : { fileName: media.fileName }),
    });
  }
}

export function createTelegramPluginModule(
  createRuntime: TelegramRuntimeFactory = createTelegramConnectorRuntime,
) {
  return definePluginModule((manifest) => definePlugin({
    manifest,
    activate: {
      'telegram-messaging': async (context) => {
        const botToken = await context.secrets.get('botToken');
        const runtime = createRuntime({
          config: { botToken },
          host: { deliver: (message) => context.connectors.deliver('telegram', message) },
          logger: context.logger,
        });
        await runtime.start();
        return {
          actions: { 'telegram.outbound': (input) => deliver(runtime.outbound, input) },
          dispose: () => runtime.stop(),
        };
      },
    },
  }));
}

export default createTelegramPluginModule();
