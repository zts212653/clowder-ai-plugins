/** Admit a persisted same-instance external source through the Host's existing Queue.
 * This port does not provide a launch grant, private Work receipt or business reply. */
export interface PluginPublicInvocationInput {
  readonly messageRef: `message:${string}`;
  readonly targetCatId: string;
  readonly native: { readonly contributionId: string; readonly methods: readonly string[] };
  readonly authority: { readonly ref: string; readonly revision: string };
}
export interface PluginPublicInvocationReceipt {
  readonly messageRef: `message:${string}`;
  readonly entryId: string;
  readonly status: 'queued' | 'processing' | 'terminal';
}
export interface PluginPublicInvocationHost {
  enqueue(input: PluginPublicInvocationInput): Promise<Readonly<PluginPublicInvocationReceipt>>;
}

function invalid(): never { throw new TypeError('Invalid public invocation admission ABI'); }
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const names = Reflect.ownKeys(value);
  if (names.length !== keys.length || names.some(key => typeof key !== 'string' || !keys.includes(key))) invalid();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid();
    result[key] = descriptor.value;
  }
  return result;
}
function coordinate(value: unknown, max = 512): string {
  if (typeof value !== 'string' || !value.length || value.length > max || value.trim() !== value ||
    [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) invalid();
  return value;
}
function capture(value: unknown): PluginPublicInvocationInput {
  const input = fields(value, ['messageRef', 'targetCatId', 'native', 'authority']);
  const native = fields(input.native, ['contributionId', 'methods']);
  const authority = fields(input.authority, ['ref', 'revision']);
  if (typeof input.messageRef !== 'string' || !/^message:\S{1,500}$/u.test(input.messageRef)) invalid();
  coordinate(input.messageRef.slice(8));
  const raw = native.methods;
  if (!Array.isArray(raw) || !raw.length || raw.length > 256) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(descriptors).length !== raw.length + 1) invalid();
  const methods = Array.from({ length: raw.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid();
    return coordinate(descriptor.value, 256);
  });
  if (new Set(methods).size !== methods.length || methods.includes('host.public-invocation.assert-current')) invalid();
  // Host canonicalizes method order when constructing its authoritative carrier.
  return Object.freeze({ messageRef: input.messageRef as `message:${string}`, targetCatId: coordinate(input.targetCatId),
    native: Object.freeze({ contributionId: coordinate(native.contributionId, 256), methods: Object.freeze(methods) }),
    authority: Object.freeze({ ref: coordinate(authority.ref), revision: coordinate(authority.revision) }) });
}

/** Host keeps installation, declaration, source, owner and business verifier authority.
 * SDK adds existing feature grants and before/after lifecycle checks, never retries writes.
 * Rejection of a late receipt does not undo effects already committed by the Host. */
export function createPublicInvocationClient(host: PluginPublicInvocationHost, assertAccess: () => void): PluginPublicInvocationHost {
  if (!host || typeof host.enqueue !== 'function') throw new TypeError('Host public invocation port requires enqueue');
  return Object.freeze({
    async enqueue(value: PluginPublicInvocationInput) {
      assertAccess();
      const input = capture(value);
      const result = await host.enqueue(input);
      assertAccess();
      const receipt = fields(result, ['messageRef', 'entryId', 'status']);
      if (receipt.messageRef !== input.messageRef || !['queued', 'processing', 'terminal'].includes(receipt.status as string)) invalid();
      return Object.freeze({ messageRef: input.messageRef, entryId: coordinate(receipt.entryId),
        status: receipt.status as PluginPublicInvocationReceipt['status'] });
    },
  });
}
