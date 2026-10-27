/** Shared health policy: an unobserved page is neither obsolete nor ready to send. */
export function projectHealthResult(request, result) {
  const { status, errorCode, observedRevisions: observed } = result;
  const expected = request.expectedRevisions;
  if (status === 'stale_adapter' || errorCode?.startsWith('STALE_')) {
    return { status: 'stale_adapter', errorCode: errorCode ?? 'STALE_ADAPTER' };
  }
  if (!observed) {
    return status === 'failed'
      ? { status, errorCode }
      : { status: 'stale_adapter', errorCode: 'STALE_ADAPTER' };
  }
  if (observed.helper !== expected.helper) return { status: 'stale_adapter', errorCode: 'STALE_HELPER' };
  if (observed.extension !== expected.extension) return { status: 'stale_adapter', errorCode: 'STALE_EXTENSION' };
  if (status === 'failed') return { status, errorCode };
  if (observed.pageAdapter === expected.pageAdapter) return { status, errorCode };
  if (status === 'dormant' && observed.pageAdapter === 'unobserved') {
    if (request.conversationId === undefined && (!errorCode || errorCode === 'CONVERSATION_NOT_SELECTED')) {
      return { status, errorCode: 'CONVERSATION_NOT_SELECTED' };
    }
    if (request.conversationId !== undefined && ['BOUND_TAB_NOT_FOUND', 'AMBIGUOUS_BOUND_TABS'].includes(errorCode)) {
      return { status, errorCode };
    }
  }
  return { status: 'stale_adapter', errorCode: 'STALE_PAGE_ADAPTER' };
}
