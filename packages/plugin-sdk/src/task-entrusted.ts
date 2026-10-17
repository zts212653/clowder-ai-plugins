import { capturePluginTaskAdmissionInput, assertPluginTaskAdmissionResult,
  assertPluginTaskDispatchInput, assertPluginTaskDispatchResult } from '@clowder-ai/plugin-contract';
import type { PluginTaskHost } from './module-host.js';
export type { PluginTaskAdmissionInput, PluginTaskAdmissionResult, PluginTaskDispatchInput,
  PluginTaskDispatchResult } from '@clowder-ai/plugin-contract';

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
/** Selectors only. Host owns source, authenticated owner, receipts, Task and execution authority. */
export function createEntrustedTaskClient(host: PluginTaskHost, assertAccess: () => void):
  Pick<PluginTaskHost, 'prepareEntrusted' | 'dispatchEntrusted'> {
  for (const key of ['prepareEntrusted', 'dispatchEntrusted'] as const)
    if (host[key] !== undefined && typeof host[key] !== 'function') throw new TypeError(`Host ${key} must be callable`);
  const prepare = host.prepareEntrusted?.bind(host), dispatch = host.dispatchEntrusted?.bind(host);
  return Object.freeze({
    ...(prepare ? { async prepareEntrusted(raw: Parameters<NonNullable<PluginTaskHost['prepareEntrusted']>>[0]) {
      assertAccess(); const input = freeze(capturePluginTaskAdmissionInput(raw));
      const result = await prepare(input); assertAccess(); assertPluginTaskAdmissionResult(result);
      return freeze(structuredClone(result));
    } } : {}),
    ...(dispatch ? { async dispatchEntrusted(raw: Parameters<NonNullable<PluginTaskHost['dispatchEntrusted']>>[0]) {
      assertAccess(); assertPluginTaskDispatchInput(raw); const input = freeze(structuredClone(raw));
      const result = await dispatch(input); assertAccess(); assertPluginTaskDispatchResult(result);
      return freeze(structuredClone(result));
    } } : {}),
  });
}
