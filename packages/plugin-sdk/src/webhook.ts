import type { PluginHostActionContext } from './host-action-context.js';

/** Host-selected declared webhook request. The contribution id is the only
 * package-owned selector; business method names are not part of this port. */
export interface PluginWebhookRequest {
  readonly contributionId: string;
  readonly request: unknown;
}

export type PluginWebhookHandler = (
  input: PluginWebhookRequest,
  context?: PluginHostActionContext,
) => unknown | Promise<unknown>;

export interface PluginWebhookSurface {
  handle(input: PluginWebhookRequest, context?: PluginHostActionContext): Promise<unknown>;
}

export function defineWebhookHandler(handler: PluginWebhookHandler): PluginWebhookSurface {
  return Object.freeze({
    async handle(input: PluginWebhookRequest, context?: PluginHostActionContext): Promise<unknown> {
      if (input === null || typeof input !== 'object' || typeof input.contributionId !== 'string' || input.contributionId.length === 0) {
        throw new TypeError('plugin webhook request requires a contribution id');
      }
      return handler(Object.freeze({ contributionId: input.contributionId, request: input.request }), context);
    },
  });
}
