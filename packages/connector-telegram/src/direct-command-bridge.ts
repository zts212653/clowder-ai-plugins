import { createConnectorCommandBridge } from '@clowder-ai/plugin-sdk';

/** This adapter has no group ingress or group permission settings. Preserve the
 * original direct-message/command behavior without the retained SDK's added
 * private-policy initialization gate. Existing stored data is left untouched. */
export function createDirectCommandBridge(
  context: Parameters<typeof createConnectorCommandBridge>[0],
  options: Parameters<typeof createConnectorCommandBridge>[1],
): ReturnType<typeof createConnectorCommandBridge> {
  const storage = { ...context.storage,
    async get(key: string) {
      // Keep the scoped Host read/currentness fence even though group policy
      // does not apply here; malformed old group data cannot block a DM.
      const current = await context.storage.get(key);
      return key === 'connector.permissions.v1' ? { revision: current?.revision ?? 1,
        value: { v: 1, whitelistEnabled: false, commandAdminOnly: false,
          adminConfigured: false, adminOpenIds: [], allowedGroups: [] } } : current;
    },
  };
  // FeatureContext has capability-gated getters: do not enumerate/spread it.
  return createConnectorCommandBridge(Object.create(context, { storage: { value: storage } }), options);
}
