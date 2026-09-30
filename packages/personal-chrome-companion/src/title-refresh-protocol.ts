/** The helper's existing title exchange uses v1 independently of message protocol v2. */
export interface PersonalChromeTitleRefreshRequest {
  readonly v: 1;
  readonly kind: 'refresh_conversation_titles';
  readonly requestId: string;
  readonly expectedHelperRevision: string;
}

export type PersonalChromeTitleSync =
  | { readonly status: 'synced'; readonly updatedCount: number; readonly requestedCount: number }
  | { readonly status: 'unavailable'; readonly errorCode: string };

export function parseTitleRefreshResult(value: unknown, requestId: string): PersonalChromeTitleSync {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid title receipt');
  const receipt = value as Record<string, unknown>;
  if (receipt.v !== 1 || receipt.kind !== 'conversation_titles_refreshed') throw new TypeError('invalid title protocol');
  // The helper intentionally does not echo unauthenticated request identifiers.
  const pairingRejected = receipt.requestId === 'invalid-request' &&
    receipt.status === 'unavailable' && receipt.errorCode === 'PAIRING_REJECTED';
  if (receipt.requestId !== requestId && !pairingRejected) throw new TypeError('uncorrelated title receipt');
  // A received frame proves a write occurred. A purported HOST_UNAVAILABLE
  // receipt contradicts the pre-send-only guarantee and is not trusted.
  if (receipt.status === 'unavailable' && typeof receipt.errorCode === 'string' &&
      /^[A-Z][A-Z0-9_]{2,63}$/.test(receipt.errorCode) && receipt.errorCode !== 'HOST_UNAVAILABLE') {
    return { status: 'unavailable', errorCode: receipt.errorCode };
  }
  const { requestedCount, updatedCount } = receipt;
  if (receipt.status !== 'synced' || typeof requestedCount !== 'number' || typeof updatedCount !== 'number' ||
      !Number.isInteger(requestedCount) || !Number.isInteger(updatedCount) ||
      requestedCount < 0 || requestedCount > 32 || updatedCount < 0 || updatedCount > requestedCount) {
    throw new TypeError('invalid title counts or failure code');
  }
  return { status: 'synced', updatedCount, requestedCount };
}
