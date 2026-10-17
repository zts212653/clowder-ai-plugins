import {
  type CollectiveEventEnvelope,
  type CollectiveLocation,
  type CollectiveSourceIdentity,
  type CollectiveParticipationDeclaration,
  collectiveParticipationDeclarationSchema,
  type CollectiveTarget,
  collectiveEventEnvelopeSchema,
  collectiveLocationSchema,
  collectiveSourceIdentitySchema,
  collectiveTargetSchema,
} from '../contracts/index.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { type HostRouteConfig, hostRouteConfigSchema } from './host-route-state.js';
import { type ConnectorRouteReceipt, routeReceiptSchema } from './route-receipt.js';
import { type ConnectorWorkCustody, workCustodySchema } from './work-custody-state.js';
import { workResultTextPublicationSchema } from './work-result-publication.js';
import { publicSourceBindingSchema, type CollectivePublicSourceBinding } from './public-source-custody.js';

export {
  type AgentHostRoute,
  type ChannelHostRoute,
  type DesiredParticipation,
  type HostRouteConfig,
  type ObservedCatEligibility,
  type SetHostRouteInput,
  type StandingInterest,
  setHostRouteInputSchema,
} from './host-route-state.js';
export type { ConnectorRouteReceipt } from './route-receipt.js';

export const verifiedAgentSchema = z
  .object({
    agentId: z.string().trim().min(1).max(120),
    displayName: z.string().trim().min(1).max(120),
    catId: z.string().trim().min(1).max(120),
    sessionRef: z.string().trim().min(1).max(240),
  })
  .strict();

const boundedOwnerRef = z.string().trim().min(1).max(1_000);

export const workResultArtifactSnapshotSchema = z
  .object({
    taskRef: boundedOwnerRef.regex(/^task:work:.+/),
    taskRevision: z.number().int().positive(),
    artifactRef: boundedOwnerRef,
    artifactRevision: boundedOwnerRef,
    completenessRef: boundedOwnerRef,
    previewRef: boundedOwnerRef,
    openInWorkspaceRef: boundedOwnerRef,
    textPublication: workResultTextPublicationSchema.optional(),
  })
  .strict();

const outboxItemSchema = z
  .object({
    outboxId: z.string(),
    clientEventId: z.string(),
    agent: verifiedAgentSchema.optional(),
    target: collectiveTargetSchema,
    location: collectiveLocationSchema.optional(),
    replySource: collectiveSourceIdentitySchema.optional(),
    operationKey: z.string().max(1000).optional(),
    sourceRef: z.string().max(300).optional(),
    workPurpose: z
      .object({
        taskRef: z.string().startsWith('task:work:'),
        admittedRevision: z.number().int().positive(),
        resultRevision: z.number().int().positive(),
        workId: z.string().startsWith('work_').optional(),
        executionRevision: z.number().int().positive().optional(),
        assignmentEventId: z.string().startsWith('evt_').optional(),
        progressKey: z.string().length(64).optional(),
        artifactSnapshot: workResultArtifactSnapshotSchema.optional(),
      })
      .strict()
      .optional(),
    replyToEventId: z.string().optional(),
    body: z.string(),
    status: z.enum(['prepared', 'queued', 'sending', 'accepted', 'blocked']),
    failureCode: z.string().optional(),
    acceptedEventId: z.string().optional(),
    createdAt: z.string().datetime(),
  })
  .strict();

const routeFailureSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
    message: z.string().trim().min(1).max(500),
  })
  .strict();

const inboxItemSchema = z
  .object({
    event: collectiveEventEnvelopeSchema,
    disposition: z.enum(['persisted', 'routing', 'routed', 'route_failed']),
    persistedAt: z.string().datetime(),
    routeConfigRevision: z.number().int().positive().optional(),
    routeAttemptedAt: z.string().datetime().optional(),
    routedAt: z.string().datetime().optional(),
    routeReceipt: routeReceiptSchema.optional(),
    routeFailure: routeFailureSchema.optional(),
    publicSource: publicSourceBindingSchema.optional(),
  })
  .strict()
  .superRefine((item, context) => {
    if (item.disposition === 'routed' && (!item.routedAt || !item.routeReceipt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['routeReceipt'],
        message: 'Routed inbox events require one durable Host receipt',
      });
    }
    if (item.disposition === 'route_failed' && !item.routeFailure) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['routeFailure'],
        message: 'Failed inbox routing requires one explicit failure',
      });
    }
  });

export const localAttemptSchema = z.object({
  operationId: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(['outbox', 'ack', 'participation', 'revoke']),
  semanticKey: z.string().min(1).max(500),
  identityDigest: z.string().regex(/^[a-f0-9]{64}$/),
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().positive().safe(),
  generation: z.number().int().positive().safe(),
  status: z.enum(['entered', 'held', 'settled']),
  effect: z.enum(['not_started', 'unknown']),
  proof: z.enum(['not_started', 'confirmed', 'replay_safe', 'unresolved']),
  reason: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((attempt, context) => {
  const expectedId = createHash('sha256').update(JSON.stringify([
    attempt.identityDigest, attempt.kind, attempt.semanticKey, attempt.payloadDigest,
  ])).digest('hex');
  if (attempt.operationId !== expectedId ||
    (attempt.status === 'settled' ? attempt.proof !== 'confirmed' : attempt.proof === 'confirmed') ||
    (attempt.status === 'entered' && (attempt.effect !== 'unknown' || attempt.proof !== 'unresolved')) ||
    (attempt.proof === 'not_started' && attempt.effect !== 'not_started') ||
    (attempt.proof === 'replay_safe' && attempt.effect !== 'unknown')) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Local recovery attempt identity/proof is inconsistent' });
  }
});
export type LocalAttempt = z.infer<typeof localAttemptSchema>;

const connectionSchema = z
  .object({
    serviceUrl: z.string().url(),
    clientBuildId: z.string().trim().min(1).max(120),
    serviceInstanceId: z.string(),
    collectiveId: z.string(),
    connectionId: z.string(),
    endpointId: z.string(),
    authorizedHumanId: z.string().optional(),
    endpointLabel: z.string(),
    endpointCredential: z.string().optional(),
    initialExcludedCatIds: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
    authorityStatus: z.enum(['connected', 'revoking', 'revoked']),
    revocationReason: z.enum(['owner_revoked', 'identity_rebind_required', 'service_revoked']).optional(),
    liveStatus: z.enum(['online', 'offline']),
    lastAckedSequence: z.number().int().nonnegative(),
    pendingAckSequence: z.number().int().positive().optional(),
    outbox: z.array(outboxItemSchema),
    workCustody: workCustodySchema.optional(),
    inbox: z.array(inboxItemSchema),
    createdAt: z.string().datetime(),
    localAttempts: z.array(localAttemptSchema).optional(),
    localParticipationIntents: z.record(z.string().regex(/^[a-f0-9]{64}$/), collectiveParticipationDeclarationSchema).optional(),
    lastError: z.string().optional(),
    lastErrorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{1,63}$/)
      .optional(),
  })
  .strict()
  .superRefine((connection, context) => {
    const attempts = connection.localAttempts ?? [];
    const ids = new Set<string>(), pending = new Set<string>();
    for (const attempt of attempts) {
      if (ids.has(attempt.operationId) || (attempt.status !== 'settled' && pending.has(attempt.kind)))
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['localAttempts'], message: 'Duplicate local recovery identity or unresolved family' });
      ids.add(attempt.operationId); if (attempt.status !== 'settled') pending.add(attempt.kind);
      if (attempt.kind === 'participation') {
        const declaration = connection.localParticipationIntents?.[attempt.operationId];
        if (!declaration || declaration.connectionId !== connection.connectionId ||
          declaration.collectiveId !== connection.collectiveId || declaration.serviceInstanceId !== connection.serviceInstanceId)
          context.addIssue({ code: z.ZodIssueCode.custom, path: ['localParticipationIntents'], message: 'Local participation recovery lacks original coordinates' });
      }
    }
    for (const id of Object.keys(connection.localParticipationIntents ?? {}))
      if (!attempts.some(attempt => attempt.operationId === id && attempt.kind === 'participation'))
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['localParticipationIntents'], message: 'Orphaned local participation intent' });
    if (connection.authorityStatus !== 'revoked' && (!connection.authorizedHumanId || !connection.endpointCredential)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authorizedHumanId'],
        message: 'Active endpoint authority must be bound to one Human and one credential',
      });
    }
    if (connection.authorityStatus === 'revoked' && !connection.revocationReason) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['revocationReason'],
        message: 'Revoked endpoint authority requires a reason',
      });
    }
  });

const legacyConnectionRecordSchema = z
  .object({
    connectionId: z.string(),
    reason: z.literal('identity_rebind_required'),
    migratedAt: z.string().datetime(),
    state: z.unknown(),
  })
  .strict();

const connectorStateV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    connections: z.record(z.string(), connectionSchema),
    legacyConnections: z.array(legacyConnectionRecordSchema),
    hostRoutes: z.record(z.string(), hostRouteConfigSchema).default({}),
  })
  .strict();

const legacyConnectionSchema = z
  .object({
    serviceUrl: z.string().url(),
    clientBuildId: z.string().trim().min(1).max(120),
    serviceInstanceId: z.string(),
    collectiveId: z.string(),
    connectionId: z.string(),
    endpointId: z.string(),
    endpointLabel: z.string(),
    authorityStatus: z.enum(['connected', 'revoking', 'revoked']),
    liveStatus: z.enum(['online', 'offline']),
    lastAckedSequence: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
  })
  .passthrough();

const connectorStateV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    connections: z.record(z.string(), legacyConnectionSchema),
  })
  .strict();

export type VerifiedAgent = z.infer<typeof verifiedAgentSchema>;
export type WorkResultArtifactSnapshot = z.infer<typeof workResultArtifactSnapshotSchema>;

export interface ConnectorOutboxItem {
  readonly outboxId: string;
  readonly clientEventId: string;
  readonly agent?: VerifiedAgent;
  readonly target: CollectiveTarget;
  readonly location?: CollectiveLocation;
  readonly replySource?: CollectiveSourceIdentity;
  readonly operationKey?: string;
  readonly sourceRef?: string;
  readonly workPurpose?: {
    readonly taskRef: string;
    readonly admittedRevision: number;
    readonly resultRevision: number;
    readonly workId?: string;
    readonly executionRevision?: number;
    readonly assignmentEventId?: string;
    readonly progressKey?: string;
    readonly artifactSnapshot?: WorkResultArtifactSnapshot;
  };
  readonly replyToEventId?: string;
  readonly body: string;
  readonly status: 'prepared' | 'queued' | 'sending' | 'accepted' | 'blocked';
  readonly failureCode?: string;
  readonly acceptedEventId?: string;
  readonly createdAt: string;
}

export interface ConnectorInboxItem {
  readonly publicSource?: CollectivePublicSourceBinding;
  readonly event: CollectiveEventEnvelope;
  readonly disposition: 'persisted' | 'routing' | 'routed' | 'route_failed';
  readonly persistedAt: string;
  readonly routeConfigRevision?: number;
  readonly routeAttemptedAt?: string;
  readonly routedAt?: string;
  readonly routeReceipt?: ConnectorRouteReceipt;
  readonly routeFailure?: ConnectorRouteFailure;
}

export interface ConnectorRouteFailure {
  readonly code: string;
  readonly message: string;
}

export interface ConnectorConnectionState {
  readonly serviceUrl: string;
  readonly clientBuildId: string;
  readonly serviceInstanceId: string;
  readonly collectiveId: string;
  readonly connectionId: string;
  readonly endpointId: string;
  readonly authorizedHumanId?: string;
  readonly endpointLabel: string;
  readonly endpointCredential?: string;
  readonly initialExcludedCatIds?: string[];
  readonly authorityStatus: 'connected' | 'revoking' | 'revoked';
  readonly revocationReason?: 'owner_revoked' | 'identity_rebind_required' | 'service_revoked';
  readonly liveStatus: 'online' | 'offline';
  readonly lastAckedSequence: number;
  readonly pendingAckSequence?: number;
  readonly outbox: ConnectorOutboxItem[];
  readonly workCustody?: ConnectorWorkCustody;
  readonly inbox: ConnectorInboxItem[];
  readonly createdAt: string;
  readonly localAttempts?: LocalAttempt[];
  readonly localParticipationIntents?: Record<string, CollectiveParticipationDeclaration>;
  readonly lastError?: string;
  readonly lastErrorCode?: string;
}

export interface LegacyConnectorConnectionRecord {
  readonly connectionId: string;
  readonly reason: 'identity_rebind_required';
  readonly migratedAt: string;
  readonly state: unknown;
}

export interface ConnectorState {
  readonly schemaVersion: 3;
  readonly connections: Record<string, ConnectorConnectionState>;
  readonly legacyConnections: LegacyConnectorConnectionRecord[];
  readonly hostRoutes: Record<string, HostRouteConfig>;
}

export type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

export type MutableConnectorState = DeepMutable<ConnectorState>;

export function parseConnectorState(value: unknown): ConnectorState {
  return connectorStateV3Schema.parse(value) as ConnectorState;
}

export function migrateConnectorState(value: unknown, migratedAt = new Date().toISOString()): ConnectorState {
  const version = schemaVersionOf(value);
  if (version === 3) return parseConnectorState(value);
  if (version === 2) {
    // Version 2 had no local transport provenance. Do not reinterpret remote sending as a local attempt.
    const migrated = parseConnectorState({ ...(value as Record<string, unknown>), schemaVersion: 3 });
    if (Object.values(migrated.connections).some(connection => connection.localAttempts !== undefined || connection.localParticipationIntents !== undefined))
      throw new Error('Version 2 state cannot contain local attempts');
    return migrated;
  }
  if (version !== 1) throw new Error(`Unsupported Collective Connector state schema version: ${String(version)}`);

  const legacy = connectorStateV1Schema.parse(value);
  const connections: Record<string, ConnectorConnectionState> = {};
  const legacyConnections: LegacyConnectorConnectionRecord[] = [];
  for (const [connectionId, connection] of Object.entries(legacy.connections)) {
    const sanitized = structuredClone(connection) as Record<string, unknown>;
    delete sanitized.endpointCredential;
    legacyConnections.push({
      connectionId,
      reason: 'identity_rebind_required',
      migratedAt,
      state: sanitized,
    });
    connections[connectionId] = {
      serviceUrl: connection.serviceUrl,
      clientBuildId: connection.clientBuildId,
      serviceInstanceId: connection.serviceInstanceId,
      collectiveId: connection.collectiveId,
      connectionId: connection.connectionId,
      endpointId: connection.endpointId,
      endpointLabel: connection.endpointLabel,
      authorityStatus: 'revoked',
      revocationReason: 'identity_rebind_required',
      liveStatus: 'offline',
      lastAckedSequence: connection.lastAckedSequence,
      outbox: [],
      inbox: [],
      createdAt: connection.createdAt,
      lastError: 'This connection predates Human-bound authority and must be paired again.',
      lastErrorCode: 'IDENTITY_REBIND_REQUIRED',
    };
  }
  return parseConnectorState({ schemaVersion: 3, connections, legacyConnections, hostRoutes: {} });
}

function schemaVersionOf(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !('schemaVersion' in value)) return undefined;
  return value.schemaVersion;
}
