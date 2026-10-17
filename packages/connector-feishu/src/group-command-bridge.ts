import { createConnectorCommandBridge } from '@clowder-ai/plugin-sdk';

/** The original group policy defaults to unrestricted groups and no admins.
 * Missing state is a read-only default, not an extra setup step. Configured
 * policies and command mutations remain in the existing scoped store. */
export function createGroupCommandBridge(
  context: Parameters<typeof createConnectorCommandBridge>[0],
  options: Parameters<typeof createConnectorCommandBridge>[1],
): ReturnType<typeof createConnectorCommandBridge> {
  const storage = { ...context.storage,
    async get(key: string) {
      // Keep the scoped Host currentness fence and preserve every existing
      // policy; the retained bridge still validates it before effects.
      const current = await context.storage.get(key);
      return key === 'connector.permissions.v1' && current === undefined ? { revision: 1,
        value: { v: 1, whitelistEnabled: false, commandAdminOnly: false,
          adminConfigured: false, adminOpenIds: [], allowedGroups: [] } } : current;
    },
  };
  // FeatureContext has capability-gated getters: do not enumerate/spread it.
  return createConnectorCommandBridge(Object.create(context, { storage: { value: storage } }), options);
}
