import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import type { PluginActionContext } from '@clowder-ai/plugin-sdk';
import type { VerifiedAgent } from './business/connector/state.js';
/** The injected handler is the only invocation identity channel. */
export function createCollectiveAgentVerification(assertActive: () => void) {
  const calls = new AsyncLocalStorage<{ catId: string; sessionRef: string; agent?: VerifiedAgent;
    assertCurrent: () => Promise<void>; live: boolean }>();
  const run = <T>(scope: NonNullable<ReturnType<typeof calls.getStore>>, consume: () => Promise<T>) =>
    calls.run(scope, async () => { try { await scope.assertCurrent(); return await consume(); } finally { scope.live = false; } });
  return Object.freeze({
    withAction<T>(action: PluginActionContext, consume: () => Promise<T>): Promise<T> {
      return run({ catId: action.catId, sessionRef: action.invocationId,
        assertCurrent: () => action.assertCurrent(), live: true }, consume);
    },
    withOwner<T>(agent: VerifiedAgent, assertCurrent: () => Promise<void>, consume: () => Promise<T>): Promise<T> {
      return run({ catId: agent.catId, sessionRef: agent.sessionRef,
        agent: Object.freeze({ ...agent }), assertCurrent, live: true }, consume);
    },
    async verifyAgent(agent: VerifiedAgent): Promise<boolean> {
      assertActive(); const call = calls.getStore();
      if (!call?.live) return false;
      await call.assertCurrent(); assertActive();
      return call.live && agent.agentId === agent.catId && agent.catId === call.catId &&
        agent.sessionRef === call.sessionRef && (!call.agent || isDeepStrictEqual(agent, call.agent));
    },
  });
}
