/** Type-only mirror of the Collective artifact owner seam. Host and Connector validate their own DTOs. */
import type { Readable } from 'node:stream';
export type CollectiveArtifactConstraint = {
    serviceInstanceId: string;
    collectiveId: string;
    artifactId: string;
    sourceEventId: string;
    contentRef: string;
    ownerRevision: number;
    blobDigest: string;
    humanId: string;
    action: "read" | "history" | "annotate" | "propose" | "preview" | "apply" | "cancel" | "reject";
    custodyRevision: number;
    membershipRevision: number;
    revocationEpoch: number;
    decisionRef: string;
    expiresAt: number;
    catalogueOwnerRevision?: number | undefined;
    effectMode?: "replay_only" | undefined;
    agent?: {
        humanId: string;
        membershipRevision: number;
        revocationEpoch: number;
        requestEventId: string;
        catId: string;
        connectionId: string;
        participationRevision: number;
    } | undefined;
    requestTarget?: {
        humanId: string;
        membershipRevision: number;
        revocationEpoch: number;
        requestEventId: string;
        catId: string;
        connectionId: string;
        participationRevision: number;
    } | undefined;
    reviewReply?: {
        annotationId: string;
        messageEventId: string;
    } | undefined;
    mediaReviewReply?: {
        annotationId: string;
    } | undefined;
};
export type CollectiveArtifactPublication = {
    status: "pending" | "published";
    serviceInstanceId: string;
    collectiveId: string;
    artifactId: string;
    sourceEventId: string;
    contentRef: string;
    blobDigest: string;
    createdAt: string;
    humanId: string;
    membershipRevision: number;
    connectionId: string;
    requestId: string;
    title: string;
    publicationId: string;
    endpointId: string;
    sourceLocation: {
        channelId: string;
        rootEventId?: string | undefined;
    };
    requestDigest: string;
    receiptRef?: string | undefined;
    workId?: string | undefined;
    effectPending?: boolean | undefined;
};
export type CollectiveArtifactPublicationOperation = {
    expiresAt: number;
    relayRef: string;
    publication: CollectiveArtifactPublication;
    bytesBase64: string;
};
export type CollectiveArtifactPublicationRecovery = {
    serviceInstanceId: string;
    collectiveId: string;
    connectionId: string;
    publicationId: string;
    outcome: {
        status: "committed";
        receipt: {
            contentRef: string;
            ownerRevision: 1;
            blobDigest: string;
            receiptId: string;
            previousOwnerRevision: 0;
            actor: {
                kind: "human";
                actorId: string;
            };
            operationId: string;
            outboxSequence: 1;
            operationContext: {
                custodyRevision: 1;
                requestDigest: string;
                kind: "collective-artifact:publish";
                actorHumanId: string;
                scopeRef: string;
                dispositionId: string;
            };
        };
    } | {
        status: "absent";
    };
};
export type CollectiveArtifactRelayOperation = {
    expiresAt: number;
    relayRef: string;
    constraint: CollectiveArtifactConstraint;
    requestId: string;
    payload: Record<string, unknown>;
};
export type CollectiveArtifactCustodyTransfer = {
    v: 1;
    transferId: string;
    serviceInstanceId: string;
    collectiveId: string;
    artifactId: string;
    sourceEventId: string;
    publishedByHumanId: string;
    sourceConnectionId: string;
    sourceEndpointId: string;
    sourceHumanId: string;
    targetConnectionId: string;
    targetEndpointId: string;
    targetHumanId: string;
    expectedCustodyRevision: number;
    state: "offered" | "source_prepared" | "target_ready" | "committed" | "cancelled";
    version: {
        contentRef: string;
        ownerRevision: number;
        blobDigest: string;
        receiptRef: string;
    };
    offeredByHumanId: string;
    offerRequestId: string;
    createdAt: string;
    updatedAt: string;
    sourceFinalized: boolean;
    targetFinalized: boolean;
    prepared?: CollectiveCustodyPrepared | undefined;
    ready?: CollectiveCustodyReady | undefined;
};
export type CollectiveCustodyPage = {
    transferId: string;
    digest: string;
    index: number;
    base64: string;
};
export type CollectiveCustodyPrepared = {
    version: {
        contentRef: string;
        ownerRevision: number;
        blobDigest: string;
        receiptRef: string;
    };
    preparedRef: string;
    manifest: {
        digest: string;
        totalBytes: number;
        pageCount: number;
    };
    ownerScopeRef: string;
};
export type CollectiveCustodyReady = {
    preparedRef: string;
    ownerScopeRef: string;
    readyRef: string;
    manifestDigest: string;
};
export type CollectiveArtifactMediaOperation = {
    expiresAt: number;
    relayRef: string;
    constraint: CollectiveArtifactConstraint;
    range?: string | undefined;
};
export type CollectiveMediaDescriptor = {
    status: 200 | 206 | 416;
    contentRef: string;
    ownerRevision: number;
    blobDigest: string;
    ownerReceiptRef: string;
    mediaType: "image/png" | "video/mp4";
    byteLength: number;
    start?: number | undefined;
    end?: number | undefined;
};
export type CollectiveArtifactOwnerResult = {
    status: 'ok';
    ownerDecisionRef: string;
    value: Record<string, unknown>;
} | {
    status: 'error';
    error: {
        code: 'access_denied' | 'conflict' | 'owner_unavailable' | 'invalid_request' | 'unsupported_operation' | 'unknown';
    };
};
/** Only the owner receives this capability; it contains no endpoint credential or Human bearer. */
export interface CollectiveArtifactOwnerPort {
    readonly media?: CollectiveArtifactMediaReadPort;
    readonly custody?: CollectiveArtifactCustodyTransferPort;
    publish?(operation: CollectiveArtifactPublicationOperation, authority: {
        reauthorize(): Promise<CollectiveArtifactPublication>;
    }): Promise<CollectiveArtifactOwnerResult>;
    recoverPublication?(publication: CollectiveArtifactPublication): Promise<CollectiveArtifactPublicationRecovery['outcome']>;
    execute(operation: CollectiveArtifactRelayOperation, authority: {
        reauthorize(): Promise<CollectiveArtifactConstraint>;
    }): Promise<CollectiveArtifactOwnerResult>;
}
export type CollectiveCustodyOwnerOperation = 'prepareSource' | 'readPage' | 'stageTarget' | 'attestReady' | 'finalize';
/** Fresh endpoint authority returns canonical metadata only; it never exposes credentials to the owner. */
export interface CollectiveCustodyOwnerAuthority {
    authorize(operation: CollectiveCustodyOwnerOperation): Promise<CollectiveArtifactCustodyTransfer>;
}
/** The single Connector seam owns the complete content/review/modification transfer unit. */
export interface CollectiveArtifactCustodyTransferPort {
    prepareSource(transfer: CollectiveArtifactCustodyTransfer, authority: CollectiveCustodyOwnerAuthority): Promise<CollectiveCustodyPrepared>;
    readPage(transfer: CollectiveArtifactCustodyTransfer, index: number, authority: CollectiveCustodyOwnerAuthority): Promise<CollectiveCustodyPage>;
    stageTarget(transfer: CollectiveArtifactCustodyTransfer, page: CollectiveCustodyPage, authority: CollectiveCustodyOwnerAuthority): Promise<void>;
    attestReady(transfer: CollectiveArtifactCustodyTransfer, authority: CollectiveCustodyOwnerAuthority): Promise<CollectiveCustodyReady>;
    finalize(transfer: CollectiveArtifactCustodyTransfer, authority: CollectiveCustodyOwnerAuthority): Promise<void>;
}
export type CollectiveArtifactMediaResult = Extract<CollectiveArtifactOwnerResult, {
    status: 'error';
}> | {
    status: 'ok';
    descriptor: CollectiveMediaDescriptor;
    body: Readable;
};
/** No bytes cross a JSON owner operation, Channel event, outbox, custody stage or persistent Connector state. */
export interface CollectiveArtifactMediaReadPort {
    listRetained?(input: {
        readonly after?: string;
    }, authority: CollectiveRetainedMediaAuthority): Promise<CollectiveRetainedMediaPage>;
    prepareShare?(input: CollectiveRetainedMediaShareInput, authority: CollectiveRetainedMediaAuthority): Promise<CollectiveRetainedMediaReceipt>;
    read(operation: CollectiveArtifactMediaOperation, authority: {
        reauthorize(): Promise<CollectiveArtifactConstraint>;
    }, signal: AbortSignal): Promise<CollectiveArtifactMediaResult>;
}
export type CollectiveMediaShareScope = {
    serviceInstanceId: string;
    collectiveId: string;
    artifactId: string;
    sourceEventId: string;
    custodyRevision: number;
};
export type CollectiveRetainedMediaPage = {
    items: {
        contentRef: string;
        ownerRevision: number;
        label: string;
        mediaType: "image/png" | "video/mp4";
    }[];
    nextCursor?: string | undefined;
};
/** Remote connection authority only; the Host supplies the local authenticated principal. */
export interface CollectiveRetainedMediaConstraint {
    readonly serviceInstanceId: string;
    readonly collectiveId: string;
    readonly connectionId: string;
    readonly authorizedHumanId: string;
}
export interface CollectiveRetainedMediaAuthority {
    reauthorize(): Promise<CollectiveRetainedMediaConstraint>;
}
export interface CollectiveRetainedMediaShareInput {
    readonly contentRef: string;
    readonly ownerRevision: number;
    readonly scope: CollectiveMediaShareScope;
}
export interface CollectiveRetainedMediaReceipt {
    readonly contentRef: string;
    readonly ownerRevision: number;
    readonly blobDigest: string;
    readonly mediaType: 'image/png' | 'video/mp4';
    readonly ownerReceiptRef: string;
}
