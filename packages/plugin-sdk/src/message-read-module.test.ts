import assert from "node:assert/strict";
import test from "node:test";
import { definePlugin, type FeatureContext, FeatureContextRevokedError } from "./feature-context.js";
import { definePluginModule } from "./module-plugin.js";
import type { ModulePluginHostShape } from "./module-host.js";
const fact = () => ({
  id: "original",
  threadId: "thread",
  userId: "owner",
  catId: "cat",
  content: "Original body",
  mentions: ["cat"],
  timestamp: 1,
  sourceRevision: "revision:1",
  origin: "callback" as const,
  extra: {
    stream: { turnInvocationId: "invocation" },
    causal: { kind: "invocation_reply" as const, triggerMessageId: "trigger" },
    rich: {
      v: 1 as const,
      blocks: [
        {
          id: "file",
          kind: "file",
          v: 1,
          url: "artifact:original",
          fileName: "report.md",
        },
      ],
    },
  },
});
async function fixture(get?: (id: string) => Promise<unknown>) {
  let context!: FeatureContext;
  const manifest = {
    pluginId: "dev.message-read-proof",
    version: "0.1.0",
    contractVersion: "0.1.0",
    name: "Read proof",
    runtime: { transport: "builtin", entrypoint: "dist/index.js" },
    features: [{ id: "read", name: "Read", resources: [], }],
  };
  const module = definePluginModule((input) =>
    definePlugin({
      manifest: input,
      activate: {
        read: (value) => {
          context = value;
          return { actions: {} };
        },
      },
    }),
  );
  const activation = await module.create(manifest).start({
    config: { get: async () => undefined },
    secrets: { get: async () => undefined },
    storage: {},
    tasks: {},
    threads: {},
    messaging: { get: get ?? (async () => null) },
    media: {},
    log() {},
  } as unknown as ModulePluginHostShape);
  const read = context.messaging.get;
  return { context, activation, read };
}
test("approved generic get reaches a feature as detached frozen public facts, preserving absence and null", async () => {
  const old = await fixture();
  assert.equal(await old.read('missing'), null);
  await old.activation.stop({reason:'test'});
  const original = fact();
  let reply: unknown = original;
  const f = await fixture(async (id) => {
    assert.equal(id, "original");
    return reply;
  });
  try {
    assert.ok(f.read, "Host generic message get must reach the module feature");
    const result = await f.read("original");
    assert.deepEqual(result, original);
    assert.notEqual(result, original);
    assert.ok(Object.isFrozen((result as ReturnType<typeof fact>).extra.rich.blocks));
    original.extra.stream.turnInvocationId = "changed";
    assert.equal((result as ReturnType<typeof fact>).extra.stream.turnInvocationId, "invocation");
    reply = null;
    assert.equal(await f.read("original"), null);
  } finally {
    await f.activation.stop({reason:'test'});
  }
});
test("read refuses malformed selectors before Host effects", async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    return fact();
  });
  try {
    assert.ok(f.read);
    for (const id of ["", " original ", "x".repeat(501)]) await assert.rejects(f.read(id), TypeError);
    assert.equal(calls, 0);
    await f.read("original");
    assert.equal(calls, 1);
  } finally {
    await f.activation.stop({reason:'test'});
  }
});
test("wrong-message, expanded private extra, custody, nested getters and malformed facts fail closed", async () => {
  let reply: unknown = fact(),
    reads = 0;
  const f = await fixture(async () => reply);
  try {
    assert.ok(f.read);
    const getter = Object.defineProperty(fact().extra.stream, "turnInvocationId", {
      enumerable: true,
      get() {
        reads++;
        return "forged";
      },
    });
    for (const value of [
      { ...fact(), id: "other" },
      { ...fact(), queueCustody: {} },
      { ...fact(), extra: { ...fact().extra, callbackToken: "secret" } },
      { ...fact(), extra: { ...fact().extra, stream: getter } },
      { ...fact(), mentions: [5] },
      { ...fact(), sourceRevision: "" },
      { ...fact(), origin: "owner" },
    ]) {
      reply = value;
      await assert.rejects(f.read("original"), TypeError);
    }
    assert.equal(reads, 0);
  } finally {
    await f.activation.stop({reason:'test'});
  }
});
test("an activation stopped during get never accepts the late read and never retries", async () => {
  let resolve!: (value: unknown) => void,
    calls = 0;
  const f = await fixture(async () => {
    calls++;
    return new Promise((r) => {
      resolve = r;
    });
  });
  assert.ok(f.read);
  const pending = f.read("original");
  await f.activation.stop({reason:'test'});
  resolve(fact());
  await assert.rejects(pending, FeatureContextRevokedError);
  assert.equal(calls, 1);
});

test("source projects its public fields and sender while malformed declared fields refuse", async () => {
  let reply: unknown = {
    ...fact(),
    source: {
      connector: "c",
      label: "C",
      icon: "i",
      url: "original",
      meta: { opaque: { x: 1 } },
      sender: { id: "sender", name: "Name", hiddenAuthority: "secret" },
      hiddenAuthority: "secret",
    },
  };
  const f = await fixture(async () => reply);
  try {
    assert.ok(f.read);
    const result = (await f.read("original")) as { source: unknown };
    assert.deepEqual(result.source, {
      connector: "c",
      label: "C",
      icon: "i",
      url: "original",
      meta: { opaque: { x: 1 } },
      sender: { id: "sender", name: "Name" },
    });
    for (const source of [
      { connector: "c", icon: "i" },
      { connector: "c", label: "C" },
      { connector: "c", label: 7, icon: "i" },
      { connector: "c", label: "C", icon: {} },
      { connector: "c", label: "C", icon: "i", sender: { id: 7 } },
      { connector: "c", label: "C", icon: "i", sender: { id: "s", name: 7 } },
      { connector: "c", label: "C", icon: "i", meta: [] },
    ]) {
      reply = { ...fact(), source };
      await assert.rejects(f.read("original"), TypeError);
    }
  } finally {
    await f.activation.stop({reason:'test'});
  }
});

test("all content variants project declared structure and preserve only explicit opaque leaves", async () => {
  const blocks = [
    { type: "text", text: "" },
    { type: "image", url: "image", alt: "" },
    {
      type: "file",
      url: "file",
      fileName: "name",
      mimeType: "text/plain",
      fileSize: 0,
    },
    { type: "code", code: "", language: "js", filename: "x.js" },
    {
      type: "tool_call",
      toolName: "tool",
      toolId: "id",
      input: { opaque: { hiddenAuthority: "data" } },
    },
    {
      type: "tool_result",
      toolId: "id",
      result: { opaque: "data" },
      isError: false,
    },
    { type: "context_attachment", attachment: { opaque: "data" } },
  ];
  const f = await fixture(async () => ({
    ...fact(),
    contentBlocks: blocks.map((block) => ({
      ...block,
      hiddenAuthority: "secret",
    })),
  }));
  try {
    assert.ok(f.read);
    const result = (await f.read("original")) as { contentBlocks: unknown };
    assert.deepEqual(result.contentBlocks, blocks);
    assert.ok(Object.isFrozen(result.contentBlocks));
  } finally {
    await f.activation.stop({reason:'test'});
  }
});

test("malformed content discriminants and variant fields cannot acquire the declared public type", async () => {
  let block: unknown;
  const f = await fixture(async () => ({ ...fact(), contentBlocks: [block] }));
  try {
    assert.ok(f.read);
    for (block of [
      { type: "unknown" },
      { type: "text" },
      { type: "text", text: 5 },
      { type: "image", url: "image", alt: 5 },
      {
        type: "file",
        url: "file",
        fileName: "x",
        mimeType: "text/plain",
        fileSize: "5",
      },
      { type: "code", code: "x", language: 5 },
      { type: "tool_call", toolName: "tool", toolId: "id", input: [] },
      { type: "tool_result", toolId: "id", result: null, isError: "false" },
      { type: "context_attachment" },
    ])
      await assert.rejects(f.read("original"), TypeError);
  } finally {
    await f.activation.stop({reason:'test'});
  }
});
