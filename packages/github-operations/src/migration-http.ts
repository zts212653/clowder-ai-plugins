import type { FeatureContext, PluginActionHandler } from '@clowder-ai/plugin-sdk';
import type { GitHubMigrationRuntime } from './migration-runtime.js';

export const migrationOperations = ['status','source','stage','commit','recover','abort','release'] as const;
/** Standard declared owner HTTP forwarding; never trusts an input principal or
 * native invocation as a substitute for the Host's authenticated third context. */
export function migrationActions(context: FeatureContext, runtime: GitHubMigrationRuntime, recoverOutcomes: () => Promise<void>): Record<string, PluginActionHandler> {
  return { ...Object.fromEntries(migrationOperations.map(operation => [`github.migration.${operation}`,
    (async (value, native, owner) => {
      if (native || owner?.kind !== 'owner-http-request' || owner.pluginInstanceId !== context.pluginInstanceId)
        throw new Error('Authenticated installation owner HTTP required');
      const input = value as { request?: { principal?: { kind?: string; id?: string }; method?: string; path?: string; body?: unknown } } | null;
      const request = input?.request;
      const read = operation === 'status' || operation === 'source';
      if (!request || request.principal?.kind !== 'owner' || request.principal.id !== owner.userId
        || request.method !== (read ? 'GET' : 'POST') || request.path !== `github/migration/${operation}`
        || owner.operation !== (read ? 'read' : 'write')) throw new Error('Owner migration request does not match its declared operation');
      const check = async () => { owner.signal.throwIfAborted(); await owner.assertCurrent(); };
      await check(); const result = await runtime.owner(operation, request.body ?? {}, owner.userId, check); await check();
      if (operation === 'release') { await recoverOutcomes(); await check(); }
      return { status: 200, headers: { 'content-type': 'application/json' }, body: result };
    }) satisfies PluginActionHandler])),
    ...Object.fromEntries(['status','source'].map(operation => [`github.migration.owner-${operation}`,
      (async (_value, native, owner) => {
        if (native || owner?.kind !== 'owner-operation' || owner.pluginInstanceId !== context.pluginInstanceId)
          throw new Error('Authenticated owner recovery operation required');
        const check = async () => { owner.signal.throwIfAborted(); await owner.assertCurrent(); };
        await check(); return runtime.owner(operation, {}, owner.userId, check);
      }) satisfies PluginActionHandler])),
    'github.migration.bind-wait': (value, caller, owner) => {
      if (owner) throw new Error('Original native owner invocation required for first Host wait binding');
      return runtime.bind(value, caller);
    },
  };
}
