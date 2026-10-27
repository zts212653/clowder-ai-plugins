import type { ModulePluginHostShape, PluginActionHandler, PluginHostActionContext, PluginModuleEntrypoint, PluginOwnerOperationContext } from '@clowder-ai/plugin-sdk';
import { GhTeamProvider } from './github.js';
import { IssueTeamRuntime, WORKBENCH_METHODS } from './runtime.js';
import type { TeamContext, TeamProvider } from './types.js';
import { readFile } from 'node:fs/promises';
export { GhTeamProvider } from './github.js';

export const TEAM_METHODS = ['inspect', 'analyze', 'submit', 'get', 'list', 'receive', 'report', 'feedback', 'statistics'] as const;

/** Implements the public module ABI directly. Host owns manifest validation,
 * grants, caller identity and supervised lifetime. No copied private Host API,
 * runtime SDK dependency, or bundled schema loader is needed by this adapter. */
export function createIssueTeamModule(provider?: TeamProvider): PluginModuleEntrypoint {
  return {
    create(manifest: unknown) {
      const declared = manifest as { pluginId?: unknown; runtime?: { entrypoint?: unknown } } | null;
      if (declared?.pluginId !== 'dev.clowder.issue-workbench' || declared.runtime?.entrypoint !== 'dist/team-plugin.js') {
        throw new Error('Issue team module requires its matching Host-validated manifest');
      }
      return {
        async start(host: ModulePluginHostShape) {
          let stopped = false;
          const current = () => { if (stopped) throw new Error('Issue team module has stopped'); };
          const context: TeamContext = { ...host, messaging: {
            get: id => host.messaging.get(id),
            subscribe: async () => { throw new Error('Issue team module declares no message subscription'); },
            unsubscribe: async () => { throw new Error('Issue team module declares no message subscription'); },
            send: (threadId, input) => { current(); return host.messaging.send({ ...input, threadId }); },
          } };
          const runtime = new IssueTeamRuntime(context, provider ?? new GhTeamProvider());
          let lastRecovery: unknown = null;
          const recover = async (authority?: PluginOwnerOperationContext) => {
            current();
            try { lastRecovery = { state: 'checked', results: await runtime.recover(authority), checkedAt: Date.now() }; }
            catch (error) {
              current(); authority?.signal.throwIfAborted(); await authority?.assertCurrent();
              lastRecovery = { state: 'needs-setup', reason: error instanceof Error ? error.message : 'Setup required' };
            }
            return { render: 'status', data: lastRecovery };
          };
          const owner = async (authority?: PluginHostActionContext) => {
            current();
            if (!authority || authority.pluginInstanceId !== host.pluginInstanceId || authority.kind !== 'owner-operation') throw new Error('Authenticated Host Settings authority required');
            authority.signal.throwIfAborted();
            await authority.assertCurrent(); current();
          };
          const actions: Record<string, PluginActionHandler> = Object.fromEntries(TEAM_METHODS.map(method => [
            `issue.team.${method}`, async (input, caller) => { current(); return { data: await runtime.invoke(method, input, caller) }; },
          ]));
          actions['issue.workbench.asset'] = async (input, caller, authority) => {
            current();
            if (caller || authority?.kind !== 'owner-http-request' || authority.pluginInstanceId !== host.pluginInstanceId
              || authority.operation !== 'read') throw new Error('Authenticated owner HTTP read required');
            await authority.assertCurrent(); authority.signal.throwIfAborted();
            const request = input as { request?: { path?: unknown; method?: unknown }; path?: unknown; method?: unknown };
            const http = request.request ?? request;
            const assets: Record<string, string> = { 'installed.html': 'text/html; charset=utf-8', 'installed.js': 'text/javascript; charset=utf-8',
              'browser.js': 'text/javascript; charset=utf-8', 'browser.css': 'text/css; charset=utf-8' };
            const name = typeof http.path === 'string' ? /^workbench\/([a-z.]+)$/.exec(http.path)?.[1] : undefined;
            if (http.method !== 'GET' || !name || !Object.hasOwn(assets, name)) return { status: 404, headers: {}, body: 'Not found' };
            const body = await readFile(new URL(name, import.meta.url), 'utf8');
            await authority.assertCurrent(); authority.signal.throwIfAborted(); current();
            return { status: 200, headers: { 'content-type': assets[name], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, body };
          };
          actions['issue.team.poll'] = async (_input, caller, authority) => {
            if (caller || authority) throw new Error('Team poll is reserved for the declared Host schedule');
            return recover();
          };
          actions['issue.team.health'] = async (_input, caller, authority) => {
            if (caller) throw new Error('Use native read tools from a conversation');
            await owner(authority);
            if (authority?.kind !== 'owner-operation' || authority.operationKey !== 'teamStatus' || authority.actionId !== 'status') throw new Error('Matching status action authority required');
            return { render: 'status', data: { recovery: lastRecovery, configured: !!await host.config.get('repositories'),
              automaticAssignment: await host.config.get('automaticAssignment') === true,
              receiveAssignments: await host.config.get('receiveAssignments') === true,
              shareProgress: await host.config.get('shareProgress') === true } };
          };
          actions['issue.team.retry'] = async (_input, caller, authority) => {
            if (caller) throw new Error('Use native receive from a conversation');
            await owner(authority);
            if (authority?.kind !== 'owner-operation' || authority.operationKey !== 'teamStatus' || authority.actionId !== 'retry') throw new Error('Matching retry action authority required');
            return recover(authority);
          };
          for (const method of WORKBENCH_METHODS) {
            actions['issue.workbench.' + method] = async (params, caller, authority) => {
              if (caller) throw new Error('Owner action cannot use a cat caller');
              await owner(authority);
              const payload = (params as { input?: { payload?: unknown } })?.input?.payload;
              if (payload !== undefined && (typeof payload !== 'string' || payload.length > (method === 'coordination' ? 256000 : 16000))) throw new Error('Invalid workbench payload');
              return { render: 'status', data: await runtime.invokeOwner(method,
                payload === undefined ? {} : JSON.parse(payload as string), authority as import('@clowder-ai/plugin-sdk').PluginOwnerOperationContext) };
            };
          }
          await recover();
          return { actions, configRefresh: async () => { await recover(); }, stop: async () => { stopped = true; await runtime.stop(); } };
        },
      };
    },
  };
}
export default createIssueTeamModule();
