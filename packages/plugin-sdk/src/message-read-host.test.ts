import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  createFeatureContextSession,
  type FeatureBinding,
  type FeatureHostAdapter,
} from "./feature-context.js";

// The Host is a separate repository. Supplying its API source directory runs
// its actual producer; ordinary SDK-only checkouts retain the module tests.
const hostSource = process.env.CLOWDER_HOST_API_SRC;
test("real Host producer crosses the SDK sender boundary", { skip: !hostSource }, async () => {
  const { createPluginMessagingHost } = await import(pathToFileURL(join(
    hostSource!, "domains/plugin/host-surface/plugin-messaging-host.ts",
  )).href);
  const message: Record<string, unknown> = {
    id: "message", threadId: "thread", userId: "owner", catId: null,
    content: "Public body", mentions: [], timestamp: 1, deliveryStatus: "delivered",
  };
  const host = createPluginMessagingHost({
    pluginId: "dev.sender-contract", pluginInstanceId: "instance", ownerUserId: "owner",
    manifest: { contractVersion: "0.3.2-candidate.0" },
    messageStore: { getById: async () => message },
    threadStore: { get: async () => ({ id: "thread" }) }, messaging: {},
  });
  let oldHost = false;
  const session = createFeatureContextSession({
    pluginInstanceId: "instance", featureId: "feature", packageRevision: "revision",
    activationRevision: 1, integrityEpoch: 0, executionLease: "lease",
  } as FeatureBinding, {
    getMessage: async (id: string) => {
      const value = await host.get(id);
      if (!oldHost || value === null) return value;
      const { from: _from, ...legacy } = value;
      return legacy;
    },
  } as FeatureHostAdapter);
  try {
    for (const [stored, expected] of [
      [{ kind: "user", userId: "owner" }, { kind: "user", userId: "owner" }],
      [{ kind: "agent", catId: "agent" }, { kind: "agent", catId: "agent" }],
      [{ kind: "external", connectorId: "private-connector" }, { kind: "external" }],
      [{ kind: "plugin", instanceId: "private-instance" }, { kind: "plugin" }],
      [{ kind: "system", service: "private-service" }, { kind: "system" }],
    ]) {
      message.from = stored;
      const result = await session.context.messaging.get("message");
      assert.ok(result);
      assert.deepEqual(result.from, expected);
      assert.ok(Object.isFrozen(result.from));
      assert.equal(JSON.stringify(result).includes("private-"), false);
    }
    message.from = { kind: "user", userId: "owner" };
    message.source = { connector: "display-only", label: "System", icon: "icon" };
    assert.deepEqual((await session.context.messaging.get("message"))?.from,
      { kind: "user", userId: "owner" });
    oldHost = true;
    const legacy = await session.context.messaging.get("message");
    assert.ok(legacy);
    assert.equal(Object.hasOwn(legacy, "from"), false);
    oldHost = false;
    message.userId = "foreign-owner";
    assert.equal(await session.context.messaging.get("message"), null);
    message.userId = "owner";
    message.deletedAt = 1;
    assert.equal(await session.context.messaging.get("message"), null);
  } finally {
    await session.revoke();
  }
  await assert.rejects(session.context.messaging.get("message"), /revoked/);
});
