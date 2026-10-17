import type { PluginMessageContent } from "./module-host.js";

/** Public persistent facts, never invocation permission, custody, or a bearer.
 * Source/meta and file blocks remain untrusted business data. */
export interface PluginMessage {
  readonly id: string;
  readonly threadId: string;
  readonly userId: string;
  readonly catId: string | null;
  readonly content: string;
  readonly mentions: readonly string[];
  readonly timestamp: number;
  readonly sourceRevision: string;
  readonly contentBlocks?: readonly PluginMessageContent[];
  readonly source?: {
    readonly connector: string;
    readonly label: string;
    readonly icon: string;
    readonly url?: string;
    readonly meta?: Readonly<Record<string, unknown>>;
    readonly sender?: { readonly id: string; readonly name?: string };
  };
  readonly origin?: "stream" | "callback" | "briefing";
  readonly replyTo?: string;
  readonly deliveryStatus?: "queued" | "delivered" | "canceled";
  readonly extra?: {
    readonly rich?: { readonly v: 1; readonly blocks: readonly unknown[] };
    readonly stream?: {
      readonly invocationId?: string;
      readonly turnInvocationId?: string;
    };
    readonly causal?: {
      readonly kind: "invocation_reply";
      readonly triggerMessageId: string;
      readonly triggerThreadId?: string;
    };
  };
}
function invalid(): never {
  throw new TypeError("Invalid Host message read fact");
}
function data(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object") return false;
  const array = Array.isArray(value);
  if (!array && ![null, Object.prototype].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value).filter((key) => !(array && key === "length"));
  if (array && (keys.length !== value.length || keys.some((key, index) => key !== String(index))))
    return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      typeof key === "string" &&
      descriptor?.enumerable === true &&
      "value" in descriptor &&
      data(descriptor.value, depth + 1)
    );
  });
}
function object(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (
    required.some((key) => !Object.hasOwn(row, key)) ||
    Object.keys(row).some((key) => !required.includes(key) && !optional.includes(key))
  )
    invalid();
  return row;
}
function text(value: unknown, allowEmpty = false): boolean {
  return typeof value === "string" && (allowEmpty || value.length > 0);
}
type FieldCheck = (value: unknown) => boolean;
const string: FieldCheck = (value) => typeof value === "string";
const record: FieldCheck = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const opaque: FieldCheck = () => true; // data() already rejects non-JSON/accessor values.
/** Project declared structural fields; unknown leaves are explicit in each shape.
 * Never copy an entire Store source/block into the SDK public result. */
function project(
  value: unknown,
  required: Readonly<Record<string, FieldCheck>>,
  optional: Readonly<Record<string, FieldCheck>> = {},
): Record<string, unknown> {
  if (!record(value)) invalid();
  const row = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, check] of Object.entries(required)) {
    if (!Object.hasOwn(row, key) || !check(row[key])) invalid();
    output[key] = row[key];
  }
  for (const [key, check] of Object.entries(optional)) {
    if (!Object.hasOwn(row, key)) continue;
    if (!check(row[key])) invalid();
    output[key] = row[key];
  }
  return output;
}
function source(value: unknown): Record<string, unknown> {
  const output = project(
    value,
    { connector: (v) => text(v), label: string, icon: string },
    {
      url: string,
      meta: record,
      sender: record,
    },
  );
  if (output.sender !== undefined) output.sender = project(output.sender, { id: string }, { name: string });
  return output;
}
function block(value: unknown): Record<string, unknown> {
  if (!record(value)) invalid();
  const type = (value as Record<string, unknown>).type;
  const required = { type: string };
  switch (type) {
    case "text":
      return project(value, { ...required, text: string });
    case "image":
      return project(value, { ...required, url: string }, { alt: string });
    case "file":
      return project(value, {
        ...required,
        url: string,
        fileName: string,
        mimeType: string,
        fileSize: (v) => typeof v === "number" && Number.isFinite(v),
      });
    case "code":
      return project(value, { ...required, code: string }, { language: string, filename: string });
    case "tool_call":
      return project(value, {
        ...required,
        toolName: string,
        toolId: string,
        input: record,
      });
    case "tool_result":
      return project(
        value,
        { ...required, toolId: string, result: opaque },
        {
          isError: (v) => typeof v === "boolean",
        },
      );
    case "context_attachment":
      return project(value, { ...required, attachment: opaque });
    default:
      return invalid();
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}
function fact(value: unknown, id: string): PluginMessage | null {
  if (value === null) return null;
  if (!data(value)) invalid();
  const row = object(
    value,
    ["id", "threadId", "userId", "catId", "content", "mentions", "timestamp", "sourceRevision"],
    ["contentBlocks", "source", "origin", "replyTo", "deliveryStatus", "extra"],
  );
  if (
    row.id !== id ||
    !["threadId", "userId", "sourceRevision"].every((key) => text(row[key])) ||
    !(row.catId === null || text(row.catId)) ||
    !text(row.content, true) ||
    !Array.isArray(row.mentions) ||
    !row.mentions.every((item) => text(item)) ||
    typeof row.timestamp !== "number" ||
    !Number.isFinite(row.timestamp)
  )
    invalid();
  const projected: Record<string, unknown> = {};
  for (const key of [
    "id",
    "threadId",
    "userId",
    "catId",
    "content",
    "mentions",
    "timestamp",
    "sourceRevision",
  ])
    projected[key] = row[key];
  if (row.contentBlocks !== undefined) {
    if (!Array.isArray(row.contentBlocks)) invalid();
    projected.contentBlocks = row.contentBlocks.map(block);
  }
  if (row.source !== undefined) projected.source = source(row.source);
  if (row.origin !== undefined && !["stream", "callback", "briefing"].includes(row.origin as string))
    invalid();
  if (
    row.deliveryStatus !== undefined &&
    !["queued", "delivered", "canceled"].includes(row.deliveryStatus as string)
  )
    invalid();
  if (row.replyTo !== undefined && !text(row.replyTo)) invalid();
  if (row.extra !== undefined) {
    const extra = object(row.extra, [], ["rich", "stream", "causal"]);
    if (extra.stream !== undefined) {
      const stream = object(extra.stream, [], ["invocationId", "turnInvocationId"]);
      if (Object.values(stream).some((value) => !text(value))) invalid();
    }
    if (extra.causal !== undefined) {
      const causal = object(extra.causal, ["kind", "triggerMessageId"], ["triggerThreadId"]);
      if (
        causal.kind !== "invocation_reply" ||
        !text(causal.triggerMessageId) ||
        (causal.triggerThreadId !== undefined && !text(causal.triggerThreadId))
      )
        invalid();
    }
    if (extra.rich !== undefined) {
      const rich = object(extra.rich, ["v", "blocks"]);
      if (rich.v !== 1 || !Array.isArray(rich.blocks)) invalid();
    }
  }
  for (const key of ["origin", "replyTo", "deliveryStatus", "extra"])
    if (row[key] !== undefined) projected[key] = row[key];
  return freeze(structuredClone(projected)) as unknown as PluginMessage;
}
/** Host owns owner/plugin/binding visibility; SDK owns the existing feature read
 * grant/lifetime and detached public shape. No message field supplies authority. */
export function createMessageReader(
  read: (id: string) => Promise<PluginMessage | null>,
  assertContentAccess: () => void,
) {
  if (typeof read !== "function") throw new TypeError("Host messaging.get must be callable");
  return async (id: string): Promise<PluginMessage | null> => {
    assertContentAccess();
    if (typeof id !== "string" || id.length < 1 || id.length > 500 || id.trim() !== id)
      throw new TypeError("Invalid messageId");
    const result = await read(id);
    assertContentAccess();
    return fact(result, id);
  };
}
