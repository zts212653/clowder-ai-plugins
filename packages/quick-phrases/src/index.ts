import { createQuickPhrases, type OwnerContext, type PhraseStorage } from './phrases.js';

export default {
  create() {
    return {
      start(host: { pluginInstanceId: string; storage: PhraseStorage }) {
        const handle = createQuickPhrases(host.storage);
        return {
          actions: {
            'quick-phrases.entries': (input: unknown, _native?: unknown, context?: OwnerContext) =>
              handle(input, context?.pluginInstanceId === host.pluginInstanceId ? context : undefined),
          },
          stop() {},
        };
      },
    };
  },
};
