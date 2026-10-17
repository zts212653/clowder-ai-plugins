/** Private activation ABI implemented by the Host. It is not an MCP/action or a launch grant. */
export interface PluginPublicInvocationVerifierInput {
  readonly authority: { readonly ref: string; readonly revision: string };
  readonly source: { readonly messageRef: `message:${string}` };
  readonly targetCatId: string;
  readonly native: { readonly contributionId: string; readonly methods: readonly string[] };
}
export interface PluginPublicInvocationVerifierContext {
  readonly signal: AbortSignal;
  assertCurrent(): Promise<void>;
}
export type PluginPublicInvocationVerifier = (
  input: PluginPublicInvocationVerifierInput,
  context: PluginPublicInvocationVerifierContext,
) => Readonly<{ current: true }> | Promise<Readonly<{ current: true }>>;

export const PUBLIC_INVOCATION_VERIFIER_METHOD = 'host.public-invocation.assert-current';
function invalid(): never { throw new TypeError('Invalid public invocation verifier ABI'); }
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
function captureInput(value: unknown): PluginPublicInvocationVerifierInput {
  const input = fields(value, ['authority', 'source', 'targetCatId', 'native']);
  const authority = fields(input.authority, ['ref', 'revision']);
  const source = fields(input.source, ['messageRef']);
  const native = fields(input.native, ['contributionId', 'methods']);
  const messageRef = coordinate(source.messageRef, 520);
  if (!messageRef.startsWith('message:')) invalid();
  coordinate(messageRef.slice(8));
  const raw = native.methods;
  if (!Array.isArray(raw) || !raw.length || raw.length > 256) invalid();
  // Reject sparse/accessor/extra array entries before taking the snapshot.
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(descriptors).length !== raw.length + 1) invalid();
  const methods = Array.from({ length: raw.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !('value' in descriptor)) invalid();
    return coordinate(descriptor.value, 256);
  });
  const sorted = [...methods].sort();
  if (new Set(methods).size !== methods.length || methods.some((method, index) => method !== sorted[index]) ||
    methods.includes(PUBLIC_INVOCATION_VERIFIER_METHOD)) invalid();
  return Object.freeze({ authority: Object.freeze({ ref: coordinate(authority.ref), revision: coordinate(authority.revision) }),
    source: Object.freeze({ messageRef: messageRef as `message:${string}` }), targetCatId: coordinate(input.targetCatId),
    native: Object.freeze({ contributionId: coordinate(native.contributionId, 256), methods: Object.freeze(methods) }) });
}

/** Preserve an absent old carrier; never read an inherited/accessor slot. */
export function capturePublicInvocationVerifier(activation: object): PluginPublicInvocationVerifier | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(activation, 'publicInvocationVerifier');
  if (!descriptor) {
    if ('publicInvocationVerifier' in activation) throw new TypeError('Public verifier must be an own data function');
    return undefined;
  }
  if (!('value' in descriptor) || typeof descriptor.value !== 'function')
    throw new TypeError('Public verifier must be an own data function');
  return descriptor.value as PluginPublicInvocationVerifier;
}

/** Host retains identity/isolation/authority. SDK adds only its owning feature lifetime and ABI snapshot. */
export function guardPublicInvocationVerifier(
  handler: PluginPublicInvocationVerifier,
  lifetime: AbortSignal,
  assertActive: () => void,
): PluginPublicInvocationVerifier {
  return async (rawInput, rawContext) => {
    const input = captureInput(rawInput);
    const call = fields(rawContext, ['signal', 'assertCurrent']);
    if (!(call.signal instanceof AbortSignal) || typeof call.assertCurrent !== 'function') invalid();
    const authority = call.assertCurrent as () => Promise<void>;
    const invocation = new AbortController();
    const signal = AbortSignal.any([call.signal, lifetime, invocation.signal]);
    let finished = false;
    const assertCurrent = async () => {
      if (finished) throw new Error('Public verifier invocation expired');
      assertActive(); signal.throwIfAborted(); await authority();
      assertActive(); signal.throwIfAborted();
      if (finished) throw new Error('Public verifier invocation expired');
    };
    let remove = () => {};
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      remove = () => signal.removeEventListener('abort', onAbort);
      if (signal.aborted) onAbort();
    });
    try {
      return await Promise.race([aborted, (async () => {
        await assertCurrent();
        const rawResult = await handler(input, Object.freeze({ signal, assertCurrent }));
        await assertCurrent();
        if (fields(rawResult, ['current']).current !== true) invalid();
        return Object.freeze({ current: true as const });
      })()]);
    } finally { finished = true; remove(); invocation.abort(); }
  };
}
