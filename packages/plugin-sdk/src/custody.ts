import {
  assertCustodyContract,
  type CustodyCanonicalizeInput, type CustodyCanonicalizeResult,
  type CustodyPreflightInput, type CustodyPreflightResult,
  type CustodyCompleteInput, type CustodyCompleteResult,
  type PredicateFreshnessInput, type PredicateFreshnessResult,
  type PredicateCompletionInput, type PredicateCompletionResult,
  type PredicateProviderBinding,
} from '@clowder-ai/plugin-contract';

export interface PluginCustodyHost {
  canonicalize(input: CustodyCanonicalizeInput): Promise<CustodyCanonicalizeResult>;
  preflight(input: CustodyPreflightInput): Promise<CustodyPreflightResult>;
  complete(input: CustodyCompleteInput): Promise<CustodyCompleteResult>;
}
interface VerifierContextBase {
  readonly tenantScope: string;
  readonly installationProjectRoot: string;
  readonly binding: PredicateProviderBinding;
  readonly assignment: { readonly holderCatIds: readonly string[]; readonly holderThreadId: string };
  readonly signal: AbortSignal;
  assertCurrent(): Promise<void>;
}
export type PluginPredicateVerifierContext = VerifierContextBase & (
  | { readonly phase: 'freshness'; readonly principal: { readonly catId: string; readonly threadId: string; readonly userId: string } }
  | { readonly phase: 'completion'; readonly principal: { readonly catId: string; readonly threadId: string; readonly userId: string; readonly invocationId: string } }
);
export type PluginPredicateVerifier = (
  input: PredicateFreshnessInput | PredicateCompletionInput,
  context: PluginPredicateVerifierContext,
) => Promise<PredicateFreshnessResult | PredicateCompletionResult>;

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
/** Snapshot JSON wire inputs so an adapter cannot mutate a caller's candidate. */
function snapshot<T>(value: T): T { return freeze(structuredClone(value)); }

/** Host-only context is not a wire object: reject hidden/accessor authority too. */
function exactContextRecord(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError('Invalid verifier context record');
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key)) ||
      keys.some(key => !Object.getOwnPropertyDescriptor(value, key)?.hasOwnProperty('value'))) {
    throw new TypeError('Unexpected verifier context fields');
  }
}

function bindVerifierContext(phase: PluginPredicateVerifierContext['phase'], context: PluginPredicateVerifierContext): PluginPredicateVerifierContext {
  exactContextRecord(context, ['phase', 'tenantScope', 'installationProjectRoot', 'binding', 'assignment', 'principal', 'signal', 'assertCurrent']);
  if (context.phase !== phase || typeof context.assertCurrent !== 'function' || !(context.signal instanceof AbortSignal)) {
    throw new TypeError('Host verifier context required');
  }
  const principalKeys = phase === 'completion' ? ['catId', 'threadId', 'userId', 'invocationId'] : ['catId', 'threadId', 'userId'];
  exactContextRecord(context.principal, principalKeys);
  if (Object.values(context.principal).some(value => typeof value !== 'string' || value.length === 0)) {
    throw new TypeError('Invalid verifier context principal');
  }
  exactContextRecord(context.assignment, ['holderCatIds', 'holderThreadId']);
  const { holderCatIds, holderThreadId } = context.assignment;
  if (!Array.isArray(holderCatIds) || !holderCatIds.length ||
      Array.from(holderCatIds).some(catId => typeof catId !== 'string' || !catId) ||
      typeof holderThreadId !== 'string' || !holderThreadId) throw new TypeError('Invalid verifier context assignment');
  exactContextRecord(context.binding, ['pluginInstanceId', 'packageDigest', 'featureId', 'contributionId', 'freshnessMethod',
    'completionMethod', 'grantRevision', 'lifecycleRevision', 'tenantScope', 'installationProjectRoot']);
  assertCustodyContract('PredicateProviderBinding', context.binding);
  if (context.tenantScope !== context.binding.tenantScope || context.installationProjectRoot !== context.binding.installationProjectRoot ||
      context.principal.userId !== context.tenantScope) throw new TypeError('Verifier context scope mismatch');

  const binding = snapshot(context.binding);
  const assignment = Object.freeze({ holderCatIds: Object.freeze(Array.from(holderCatIds)), holderThreadId });
  const { catId, threadId, userId } = context.principal;
  const checkCurrent = context.assertCurrent.bind(context);
  // Discard return values and function properties from the Host callback.
  const assertCurrent = async (): Promise<void> => { await checkCurrent(); };
  if (context.phase === 'completion') {
    return Object.freeze({ phase: 'completion', tenantScope: context.tenantScope, installationProjectRoot: context.installationProjectRoot,
      binding, assignment, principal: Object.freeze({ catId, threadId, userId, invocationId: context.principal.invocationId }),
      signal: context.signal, assertCurrent });
  }
  return Object.freeze({ phase: 'freshness', tenantScope: context.tenantScope, installationProjectRoot: context.installationProjectRoot,
    binding, assignment, principal: Object.freeze({ catId, threadId, userId }), signal: context.signal, assertCurrent });
}

export function createCustodyClient(host: PluginCustodyHost | undefined, assertActive: () => void): PluginCustodyHost {
  return {
    async canonicalize(input) {
      assertActive(); assertCustodyContract('CustodyCanonicalizeInput', input);
      if (!host) throw new Error('Host custody port unavailable');
      const result = await host.canonicalize(snapshot(input));
      assertActive(); assertCustodyContract('CustodyCanonicalizeResult', result); return snapshot(result);
    },
    async preflight(input) {
      assertActive(); assertCustodyContract('CustodyPreflightInput', input);
      if (!host) throw new Error('Host custody port unavailable');
      const result = await host.preflight(snapshot(input));
      assertActive(); assertCustodyContract('CustodyPreflightResult', result); return snapshot(result);
    },
    async complete(input) {
      assertActive(); assertCustodyContract('CustodyCompleteInput', input);
      if (!host) throw new Error('Host custody port unavailable');
      const result = await host.complete(snapshot(input));
      assertActive(); assertCustodyContract('CustodyCompleteResult', result); return snapshot(result);
    },
  };
}

/** Host must additionally isolate business ALS, validate bindings, fence IO and
 * bind the result to its frozen candidate. This wrapper grants no authority. */
export function guardPredicateVerifier(
  phase: PluginPredicateVerifierContext['phase'], handler: PluginPredicateVerifier, assertActive: () => void,
): PluginPredicateVerifier {
  return async (input, context) => {
    assertActive();
    const boundContext = bindVerifierContext(phase, context);
    const inputKind = phase === 'freshness' ? 'PredicateFreshnessInput' : 'PredicateCompletionInput';
    assertCustodyContract(inputKind, input);
    const request = snapshot(input);
    boundContext.signal.throwIfAborted(); await boundContext.assertCurrent(); assertActive();
    const result = await handler(request, boundContext);
    boundContext.signal.throwIfAborted(); await boundContext.assertCurrent(); assertActive();
    assertCustodyContract(phase === 'freshness' ? 'PredicateFreshnessResult' : 'PredicateCompletionResult', result);
    if (result.status === 'verified') {
      if (result.freshnessKey !== request.predicate.freshnessKey) throw new TypeError('Verifier freshness mismatch');
      if (phase === 'completion' && (!('predicateDigest' in result) || result.predicateDigest !== request.predicate.digest ||
          !('evidenceRefs' in request) || !request.evidenceRefs.includes(result.evidenceRef))) throw new TypeError('Verifier evidence mismatch');
    }
    return snapshot(result);
  };
}
