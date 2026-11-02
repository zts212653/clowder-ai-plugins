/** Host-owned member execution. These DTOs never carry credentials, login state,
 * working-directory authority or a caller-supplied approval/status verdict. */
export interface MemberMemoryReference {
  readonly sourceRef: string;
  readonly revision: string;
}
export interface MemberAccountSelection {
  readonly accountRef: string;
  readonly authType: 'oauth' | 'api_key';
  readonly expectedRevision?: string;
}
export interface MemberRuntimeSnapshot {
  readonly clientId: string;
  readonly model: string;
  readonly carrier: string;
  readonly account: {
    readonly accountRef: string;
    readonly authType: 'oauth' | 'api_key';
    readonly accountRevision: string;
  };
}
export interface PrepareMemberSession {
  readonly threadId: string;
  readonly catId: string;
  readonly contributionId: string;
  readonly identity: string;
  readonly accountSelection?: MemberAccountSelection;
  readonly memory: readonly MemberMemoryReference[];
}
export type CreateMemberSession = Omit<PrepareMemberSession, 'threadId'> & { readonly title: string };
/** Stable package business coordinate. It never substitutes for current owner authority. */
export interface EnsureMemberThread {
  readonly catId: string;
  readonly contributionId: string;
  readonly identity: string;
  readonly title: string;
  readonly creationKey: string;
}
/** Protection metadata only; no permission to wake, read arbitrary memory or run a model. */
export interface MemberThreadBinding {
  readonly schema: 'host.member-thread.v1';
  readonly threadId: string;
  readonly sessionId: string;
  readonly ownerUserId: string;
  readonly pluginInstanceId: string;
  readonly catId: string;
  readonly creationDigest: string;
}
export interface MemberResourceDescription {
  readonly schema: 'host.member-resources.v1';
  readonly catId: string;
  readonly runtime?: Pick<MemberRuntimeSnapshot, 'clientId' | 'model' | 'carrier'>;
  readonly defaultAccountRef?: string;
  readonly available: boolean;
  readonly reason?: string;
  readonly accounts: readonly {
    readonly accountRef: string;
    readonly displayName: string;
    readonly authType: 'oauth' | 'api_key';
    readonly accountRevision?: string;
    readonly available: boolean;
    readonly reason?: string;
    readonly selection?: MemberAccountSelection;
  }[];
  readonly memory: readonly (MemberMemoryReference & { readonly bytes: number })[];
}
export interface MemberSessionSummary extends PrepareMemberSession {
  readonly schema: 'host.member-session.v1';
  readonly sessionId: string;
  readonly ownerUserId: string;
  readonly pluginInstanceId: string;
  readonly packageDigest: string;
  readonly activationId?: string;
  readonly generation: number;
  readonly revoked: boolean;
  readonly runtime: MemberRuntimeSnapshot;
  readonly consumedCursor: number;
}
export interface ExecuteMemberSession {
  readonly sessionId: string;
  readonly generation: number;
  readonly executionId: string;
  readonly semanticCursor: number;
  readonly content: string;
}
export interface MemberSessionExecution {
  readonly executionId: string;
  readonly inputDigest: string;
  readonly semanticCursor: number;
  readonly content: string;
  readonly phase: 'admitting' | 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'interrupted';
  readonly messageId?: string;
  readonly invocationId?: string;
  readonly responseMessageId?: string;
}
export type MemberExecutionLookup = Pick<ExecuteMemberSession, 'sessionId' | 'generation' | 'executionId'>;

/** Optional module Host capability. create/prepare/revoke require a current
 * authenticated owner operation. execute consumes its existing grant only.
 * prepare accepts only an already controlled thread created by this instance.
 * Repeating an execution ID with the same complete input returns its original
 * receipt. Unknown outcomes stay on that ID; absence is not permission to retry
 * another model/account. A new activation needs explicit owner renewal.
 */
export interface PluginMemberSessionsHost {
  /** Optional on older Hosts. Current owner only; no grant, thread or model is created. */
  describe?(input: { readonly catId: string }): Promise<MemberResourceDescription>;
  /** Optional on older Hosts. Confirmed owner only. Stable across HTTP request IDs;
   * returns the same protected thread after a lost ACK, without preparing a grant. */
  ensureThread?(input: EnsureMemberThread): Promise<MemberThreadBinding>;
  create(input: CreateMemberSession): Promise<MemberSessionSummary>;
  prepare(input: PrepareMemberSession): Promise<MemberSessionSummary>;
  execute(input: ExecuteMemberSession): Promise<MemberSessionExecution>;
  get(sessionId: string): Promise<MemberSessionSummary | null>;
  /** Reads original facts after revoke/renewal; cannot wake or grant a child. */
  getExecution(input: MemberExecutionLookup): Promise<MemberSessionExecution | null>;
  revoke(sessionId: string): Promise<MemberSessionSummary>;
}
