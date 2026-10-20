import type { Readable } from 'node:stream';
import type {
  CollectiveArtifactConstraint,
  CollectiveArtifactMediaOperation,
  CollectiveMediaDescriptor,
} from '../contracts/index.js';
import type { CollectiveArtifactOwnerResult } from './artifact-owner-client.js';

export type CollectiveArtifactMediaResult =
  | Extract<CollectiveArtifactOwnerResult, { status: 'error' }>
  | { status: 'ok'; descriptor: CollectiveMediaDescriptor; body: Readable };
/** No bytes cross a JSON owner operation, Channel event, outbox, custody stage or persistent Connector state. */
export interface CollectiveArtifactMediaReadPort {
  read(
    operation: CollectiveArtifactMediaOperation,
    authority: { reauthorize(): Promise<CollectiveArtifactConstraint> },
    signal: AbortSignal,
  ): Promise<CollectiveArtifactMediaResult>;
}
