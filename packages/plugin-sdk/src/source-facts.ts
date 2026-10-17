import { projectSourceProgress, type PluginSourceProgressFact } from './source-progress.js';
export type { PluginQueueProgress, PluginSourceProgressFact } from './source-progress.js';
import {
  assertPluginSourceFact, assertPluginSourceFactsReadInput, assertPluginNativeContext,
  assertPluginNativeTaskContext, assertPluginNativeTaskContextInput,
  type PluginSourceFact, type PluginNativeContext, type PluginNativeTaskContext,
} from '@clowder-ai/plugin-contract';
export type { PluginSourceFact, PluginNativeContext, PluginNativeTaskContext, PluginSourceFactsReadInput } from '@clowder-ai/plugin-contract';

/** Host-owned authorization: same-instance owner source or the exact verified native origin only.
 * No Task/receipt/ancestor reads or background fallback are supplied by this slice. */
export interface PluginSourceFactsHost {
  read(input: { readonly messageRef: `message:${string}` }): Promise<PluginSourceFact>;
  /** Authenticated owner-only, content-free Queue display facts; absent on older carriers. */
  readProgress?(input: { readonly messageRef: `message:${string}` }): Promise<PluginSourceProgressFact>;
}
/** Native-only authenticated identity; neither a tool body nor typed-wait source supplies identity. */
export interface PluginNativeContextHost {
  /** Optional selector is additive; legacy default-only Host implementations remain assignable. */
  current(input?: { readonly includeTask: true }): Promise<PluginNativeContext>;
}
export interface PluginNativeContextClient {
  /** Explicit Task snapshot may contain bounded Host entry provenance.
   * These facts never identify manual/standing Work basis or grant execution. */
  current(input: { readonly includeTask: true }): Promise<PluginNativeTaskContext>;
  current(): Promise<PluginNativeContext>;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}
export function createSourceFactsClient(host: PluginSourceFactsHost, assertContentAccess: () => void): PluginSourceFactsHost {
  if (!host || typeof host.read !== 'function') throw new TypeError('Host source facts port requires read');
  if (host.readProgress !== undefined && typeof host.readProgress !== 'function') throw new TypeError('Host source facts readProgress must be callable');
  const readProgress = host.readProgress?.bind(host);
  return Object.freeze({
    ...(readProgress === undefined ? {} : { async readProgress(input: { readonly messageRef: `message:${string}` }) {
      assertContentAccess(); assertPluginSourceFactsReadInput(input);
      const result = await readProgress(Object.freeze({ messageRef: input.messageRef }));
      assertContentAccess();
      return freeze(projectSourceProgress(result, input.messageRef));
    } }),
    async read(input: { readonly messageRef: `message:${string}` }) {
      assertContentAccess();
      assertPluginSourceFactsReadInput(input);
      const result = await host.read(Object.freeze({ messageRef: input.messageRef }));
      assertContentAccess();
      assertPluginSourceFact(result);
      return freeze(structuredClone(result));
    },
  });
}
export function createNativeContextClient(host: PluginNativeContextHost, assertContentAccess: () => void,
  assertTaskAccess: () => void = () => { throw new Error('task.read access verifier required'); }): PluginNativeContextClient {
  if (!host || typeof host.current !== 'function') throw new TypeError('Host native context port requires current');
  async function current(input: { readonly includeTask: true }): Promise<PluginNativeTaskContext>;
  async function current(): Promise<PluginNativeContext>;
  async function current(input?: unknown): Promise<PluginNativeContext | PluginNativeTaskContext> {
    assertContentAccess();
    if (input !== undefined) { assertPluginNativeTaskContextInput(input); assertTaskAccess(); }
    const result = input === undefined ? await host.current() : await host.current(Object.freeze({ includeTask: true }));
    assertContentAccess();
    if (input === undefined) assertPluginNativeContext(result);
    else { assertTaskAccess(); assertPluginNativeTaskContext(result); }
    return freeze(structuredClone(result));
  }
  return Object.freeze({ current });
}
