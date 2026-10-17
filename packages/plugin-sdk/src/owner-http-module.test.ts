import assert from "node:assert/strict";
import test from "node:test";
import { definePlugin, FeaturePermissionError } from "./feature-context.js";
import { definePluginModule } from "./module-plugin.js";
import type { ModulePluginHostShape } from "./module-host.js";
import type { PluginOwnerHttpContext } from "./browser-services.js";

const manifest = {
  pluginId: "dev.owner-http-proof",
  version: "0.1.0",
  contractVersion: "0.1.0-beta.36",
  name: "HTTP proof",
  runtime: { transport: "builtin", entrypoint: "dist/index.js" },
  contributions: [
    { type: "webhook", id: "owner", path: "owner", methods: ["POST"], action: { method: "owner.control" } },
  ],
  features: [
    {
      id: "backend",
      name: "Backend",
      resources: [],
      capabilities: [],
      contributions: [{ type: "webhook", id: "owner" }],
    },
  ],
};
async function fixture() {
  let called = 0,
    pause: (() => Promise<void>) | undefined;
  const module = definePluginModule((input) =>
    definePlugin({
      manifest: input,
      activate: {
        backend: () => ({
          actions: {
            "owner.control": async (_input, _native, owner) => {
              called++;
              await pause?.();
              return owner;
            },
          },
        }),
      },
    }),
  );
  const active = await module
    .create(manifest)
    .start({
      config: { get: async () => undefined },
      secrets: { get: async () => undefined },
      storage: {},
      tasks: {},
      threads: {},
      messaging: {},
      media: {},
      log() {},
    } as unknown as ModulePluginHostShape);
  return {
    active,
    calls: () => called,
    pause: (fn: () => Promise<void>) => {
      pause = fn;
    },
  };
}
function caller(signal: AbortSignal): PluginOwnerHttpContext {
  return Object.freeze({
    kind: "owner-http-request",
    userId: "owner",
    pluginInstanceId: "instance",
    operation: "write",
    signal,
    requestIdentity: Object.freeze({
      kind: "owner_http",
      requestId: "Host-generated",
      transportRequestId: "caller-diagnostics",
      pluginId: manifest.pluginId,
      pluginInstanceId: "instance",
      userId: "owner",
      contributionId: "owner",
      method: "POST",
      declaredPath: "owner",
      path: "owner",
      bodyDigest: "a".repeat(64),
      queryDigest: "b".repeat(64),
    }),
    async assertCurrent() {
      signal.throwIfAborted();
    },
  });
}
test("SDK forwards Host owner HTTP facts without deriving identity or Work basis from body; legacy direct calls stay context-free", async () => {
  const f = await fixture(),
    signal = new AbortController().signal;
  try {
    const ctx = caller(signal);
    assert.equal(
      await f.active.actions["owner.control"]!({ requestId: "body-forged", kind: "standing" }, undefined, ctx),
      ctx,
    );
    assert.equal(await f.active.actions["owner.control"]!({ userId: "body-owner" }), undefined);
    assert.equal(f.calls(), 2);
  } finally {
    await f.active.stop();
  }
});
test("SDK refuses inconsistent or wrong-webhook HTTP context and native/owner mixing before entering a handler", async () => {
  const f = await fixture(),
    ctx = caller(new AbortController().signal);
  try {
    for (const context of [
      { ...ctx, operation: "read" },
      { ...ctx, userId: "foreign" },
      { ...ctx, requestIdentity: { ...ctx.requestIdentity!, contributionId: "foreign" } },
      { ...ctx, requestIdentity: { ...ctx.requestIdentity!, declaredPath: "foreign" } },
      { ...ctx, requestIdentity: { ...ctx.requestIdentity!, requestId: "" } },
    ])
      await assert.rejects(
        async () => f.active.actions["owner.control"]!({}, undefined, context as never),
        FeaturePermissionError,
      );
    await assert.rejects(async () => f.active.actions["owner.control"]!({}, {} as never, ctx), FeaturePermissionError);
    assert.equal(f.calls(), 0);
  } finally {
    await f.active.stop();
  }
});
test("the original HTTP request signal rejects both expired entry and a result arriving after request end", async () => {
  const f = await fixture(),
    ended = new AbortController(),
    ctx = caller(ended.signal);
  try {
    let finish!: () => void;
    f.pause(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.active.actions["owner.control"]!({}, undefined, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(typeof finish, "function", "the authenticated handler must enter before request end");
    ended.abort(new Error("HTTP lifetime ended"));
    finish();
    await assert.rejects(async () => pending, /lifetime ended/);
    await assert.rejects(async () => f.active.actions["owner.control"]!({}, undefined, ctx), /lifetime ended/);
    assert.equal(f.calls(), 1);
  } finally {
    await f.active.stop();
  }
});
