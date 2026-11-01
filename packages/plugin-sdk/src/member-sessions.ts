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
  create(input: CreateMemberSession): Promise<MemberSessionSummary>;
  prepare(input: PrepareMemberSession): Promise<MemberSessionSummary>;
  execute(input: ExecuteMemberSession): Promise<MemberSessionExecution>;
  get(sessionId: string): Promise<MemberSessionSummary | null>;
  /** Reads original facts after revoke/renewal; cannot wake or grant a child. */
  getExecution(input: MemberExecutionLookup): Promise<MemberSessionExecution | null>;
  revoke(sessionId: string): Promise<MemberSessionSummary>;
}
