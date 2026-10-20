import {
  type CollectiveArtifactConstraint,
  type CollectiveArtifactPublication,
  type CollectiveArtifactPublicationOperation,
  type CollectiveArtifactPublicationRecovery,
  type CollectiveArtifactRelayOperation,
  type CollectiveRetainedMediaRegistrationRequest,
  collectiveArtifactAgentContextRequestSchema,
  collectiveArtifactAgentContextSchema,
  collectiveArtifactAgentRelayRequestSchema,
  collectiveArtifactConstraintSchema,
  collectiveArtifactProjectionSchema,
  collectiveArtifactPublicationOperationSchema,
  collectiveArtifactPublicationRecordSchema,
  collectiveArtifactRelayOperationSchema,
  collectiveRetainedMediaRegistrationSchema,
  type RegisterCollectiveArtifact,
} from '../contracts/index.js';
import { z } from 'zod';
import type { CollectiveArtifactCustodyTransferPort } from './artifact-custody-owner-port.js';
import type { CollectiveArtifactMediaReadPort } from './artifact-media-owner-port.js';

type Coordinates = { serviceInstanceId: string; collectiveId: string; connectionId: string };
type Request = (
  url: string,
  path: string,
  options: { method: 'POST'; credential: string; body: unknown },
) => Promise<Record<string, unknown>>;
export type CollectiveArtifactOwnerResult =
  | { status: 'ok'; ownerDecisionRef: string; value: Record<string, unknown> }
  | {
      status: 'error';
      error: {
        code:
          | 'access_denied'
          | 'conflict'
          | 'owner_unavailable'
          | 'invalid_request'
          | 'unsupported_operation'
          | 'unknown';
      };
    };

/** Only the owner receives this capability; it contains no endpoint credential or Human bearer. */
export interface CollectiveArtifactOwnerPort {
  readonly media?: CollectiveArtifactMediaReadPort;
  readonly custody?: CollectiveArtifactCustodyTransferPort;
  publish?(
    operation: CollectiveArtifactPublicationOperation,
    authority: { reauthorize(): Promise<CollectiveArtifactPublication> },
  ): Promise<CollectiveArtifactOwnerResult>;
  recoverPublication?(
    publication: CollectiveArtifactPublication,
  ): Promise<CollectiveArtifactPublicationRecovery['outcome']>;
  execute(
    operation: CollectiveArtifactRelayOperation,
    authority: {
      reauthorize(): Promise<CollectiveArtifactConstraint>;
    },
  ): Promise<CollectiveArtifactOwnerResult>;
}

export class CollectiveArtifactOwnerClient {
  constructor(private readonly request: Request) {}
  async pollPublications(url: string, credential: string, input: Coordinates) {
    return z
      .object({ operations: z.array(collectiveArtifactPublicationOperationSchema).max(2) })
      .strict()
      .parse(await this.request(url, '/api/artifacts/publications/poll', { method: 'POST', credential, body: input }))
      .operations;
  }
  async reauthorizePublication(
    url: string,
    credential: string,
    coordinates: Coordinates,
    operation: CollectiveArtifactPublicationOperation,
  ) {
    const result = await this.request(url, '/api/artifacts/publications/validate', {
      method: 'POST',
      credential,
      body: { ...coordinates, publicationId: operation.publication.publicationId, relayRef: operation.relayRef },
    });
    return collectiveArtifactPublicationRecordSchema.parse(result.publication);
  }
  async respondPublication(
    url: string,
    credential: string,
    coordinates: Coordinates,
    relayRef: string,
    result: CollectiveArtifactOwnerResult,
  ) {
    await this.request(url, '/api/artifacts/publications/respond', {
      method: 'POST',
      credential,
      body: { ...coordinates, relayRef, ...result },
    });
  }
  async recoverPublication(url: string, credential: string, input: CollectiveArtifactPublicationRecovery) {
    await this.request(url, '/api/artifacts/publications/recover', { method: 'POST', credential, body: input });
  }
  async readContext(
    url: string,
    credential: string,
    input: z.input<typeof collectiveArtifactAgentContextRequestSchema>,
  ) {
    const body = collectiveArtifactAgentContextRequestSchema.parse(input);
    return collectiveArtifactAgentContextSchema.parse(
      await this.request(url, '/api/artifacts/agent/context', {
        method: 'POST',
        credential,
        body,
      }),
    );
  }
  async requestAgent(
    url: string,
    credential: string,
    input: z.input<typeof collectiveArtifactAgentRelayRequestSchema>,
  ) {
    const body = collectiveArtifactAgentRelayRequestSchema.parse(input);
    const response = await this.request(url, '/api/artifacts/agent/request', { method: 'POST', credential, body });
    return z
      .object({ value: z.record(z.unknown()) })
      .strict()
      .parse(response).value;
  }
  async recoverMediaCustody(
    url: string,
    credential: string,
    input: RegisterCollectiveArtifact & {
      previousConnectionId?: string;
      previousCustodyProof?: string;
    },
  ) {
    const result = await this.request(url, '/api/artifacts/media/continuity', {
      method: 'POST',
      credential,
      body: input,
    });
    return z
      .discriminatedUnion('status', [
        z.object({ status: z.literal('new') }).strict(),
        z.object({ status: z.literal('current') }).strict(),
        z.object({ status: z.literal('proof_required'), previousConnectionId: z.string() }).strict(),
        z.object({ status: z.literal('rebound'), artifact: collectiveArtifactProjectionSchema }).strict(),
      ])
      .parse(result);
  }
  async register(url: string, credential: string, input: RegisterCollectiveArtifact) {
    const result = await this.request(url, '/api/artifacts/register', { method: 'POST', credential, body: input });
    return collectiveArtifactProjectionSchema.parse(result.artifact);
  }
  async registrationContext(url: string, credential: string, input: CollectiveRetainedMediaRegistrationRequest) {
    return collectiveRetainedMediaRegistrationSchema.parse(
      await this.request(url, '/api/artifacts/register/context', { method: 'POST', credential, body: input }),
    );
  }
  async poll(url: string, credential: string, input: Coordinates) {
    return z
      .object({ operations: z.array(collectiveArtifactRelayOperationSchema).max(2) })
      .strict()
      .parse(await this.request(url, '/api/artifacts/owner/poll', { method: 'POST', credential, body: input }))
      .operations;
  }
  async reauthorize(
    url: string,
    credential: string,
    coordinates: Coordinates,
    operation: CollectiveArtifactRelayOperation,
  ) {
    const { artifactId, sourceEventId, action, ownerRevision, decisionRef } = operation.constraint;
    const result = await this.request(url, '/api/artifacts/constraints/validate', {
      method: 'POST',
      credential,
      body: { ...coordinates, artifactId, sourceEventId, action, ownerRevision, decisionRef },
    });
    return collectiveArtifactConstraintSchema.parse(result.constraint);
  }
  async respond(
    url: string,
    credential: string,
    coordinates: Coordinates,
    relayRef: string,
    result: CollectiveArtifactOwnerResult,
  ) {
    await this.request(url, '/api/artifacts/owner/respond', {
      method: 'POST',
      credential,
      body: { ...coordinates, relayRef, ...result },
    });
  }
}
