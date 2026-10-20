export interface PluginOwnerOperationContext {
  readonly kind: 'owner-operation';
  readonly userId: string;
  readonly pluginInstanceId: string;
  readonly operationKey: string;
  readonly actionId: string;
  readonly requestId: string;
  readonly signal: AbortSignal;
  assertCurrent(): Promise<void>;
}
/** Host-captured descriptor: requestId is generated at the authenticated HTTP
 * boundary; transportRequestId may be caller-supplied diagnostics only. */
export interface PluginOwnerHttpRequestIdentity {
  readonly kind: 'owner_http';
  readonly requestId: string;
  readonly transportRequestId: string;
  readonly pluginId: string;
  readonly pluginInstanceId: string;
  readonly userId: string;
  readonly contributionId: string;
  readonly method: string;
  readonly declaredPath: string;
  readonly path: string;
  readonly bodyDigest: string;
  readonly queryDigest: string;
}
/** Authenticated request facts and the existing request lifetime, not a Work
 * basis. Anonymous/direct calls have no such context; legacy seeds may lack ID. */
export interface PluginOwnerHttpContext {
  readonly kind: 'owner-http-request';
  readonly userId: string;
  readonly pluginInstanceId: string;
  readonly operation: 'read' | 'write';
  readonly requestIdentity?: PluginOwnerHttpRequestIdentity;
  readonly signal: AbortSignal;
  assertCurrent(): Promise<void>;
}
export type PluginHostActionContext = PluginOwnerOperationContext | PluginOwnerHttpContext;
