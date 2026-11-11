/** Immutable audit coordinates chosen by the Host, never an authorization input. */
export interface PluginOwnerChatOrigin {
  readonly messageId: string;
  readonly threadId: string;
  readonly helperCatId: string;
}

/** In-process handle for one current native action. Do not serialize, persist,
 * forward to another caller, or reuse after that action returns. Coordinates
 * alone cannot authorize a write. The Host remains the authority. */
export interface PluginOwnerChatDelegation {
  readonly origin: PluginOwnerChatOrigin;
  /** Recheck canonical owner/source, invocation and installation after awaits. */
  assertCurrent(): Promise<void>;
  /** Immediate final fence before a synchronous commit; do not await it. */
  assertWriteCurrent(): void;
}

/** Optional module Host port. Browser owner-operation context, body claims,
 * controlled players and adopted waits do not supply native Chat authority. */
export interface PluginOwnerChatHost {
  /** Capture the current canonical direct-owner Chat source; no caller-selected source. */
  capture(): Promise<PluginOwnerChatDelegation>;
}
