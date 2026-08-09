export type FeishuArtifactKind = 'note' | 'minute';

export interface FeishuArtifactLocator {
  readonly artifactId: string;
  readonly kind: FeishuArtifactKind;
  readonly revision?: string;
}

export interface FeishuGeneratedArtifact {
  readonly artifactId: string;
  readonly kind: FeishuArtifactKind;
  readonly revision: string;
  readonly generatedAt: string;
  readonly title?: string;
  readonly meetingId?: string;
}

export interface FeishuGeneratedArtifactPage {
  readonly artifacts: readonly unknown[];
  readonly nextCursor: string | null;
}

export interface FeishuTranscript {
  readonly text: string;
  readonly contentType: 'text/plain';
}

/**
 * Credential-free interface injected by the Host. Implementations own all
 * long-lived Feishu/lark-cli credentials and never expose them to this plugin.
 */
export interface FeishuPollingGateway {
  listGeneratedArtifacts(request: {
    readonly cursor: string | null;
    readonly limit: number;
    readonly signal: AbortSignal;
  }): Promise<FeishuGeneratedArtifactPage>;
  inspectArtifact(locator: FeishuArtifactLocator, signal: AbortSignal): Promise<unknown>;
}

export interface FeishuTranscriptGatewayRequest {
  readonly locator: Required<FeishuArtifactLocator>;
  readonly sourceHandle: string;
  readonly intakeId: string;
  /** Opaque Host-issued grant; the gateway verifies scope, expiry, and revocation. */
  readonly sourceGrant: string;
  readonly signal: AbortSignal;
}

/** Host-only transcript capability, deliberately absent from the polling runtime. */
export interface FeishuTranscriptGateway {
  resolveGrantedTranscript(request: FeishuTranscriptGatewayRequest): Promise<unknown>;
}

export type FeishuGatewayErrorCode =
  | 'AUTH_EXPIRED'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE';

export class FeishuGatewayError extends Error {
  readonly code: FeishuGatewayErrorCode;

  constructor(code: FeishuGatewayErrorCode, message: string) {
    super(message);
    this.name = 'FeishuGatewayError';
    this.code = code;
  }
}
