import type { CollectiveLocalTransport } from './service-client.js';
import type { VerifiedAgent } from './state.js';

export interface CollectiveConnectorOptions {
  readonly dataDirectory: string;
  readonly verifyAgent: (agent: VerifiedAgent) => Promise<boolean>;
  readonly fetchImpl?: typeof fetch;
  readonly localTransport?: CollectiveLocalTransport;
  readonly now?: () => number;
}
