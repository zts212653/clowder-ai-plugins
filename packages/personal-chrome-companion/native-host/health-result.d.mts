export type PersonalChromeHealthStatus = 'ready' | 'dormant' | 'stale_adapter' | 'failed';
interface Revisions { helper: string; extension: string; pageAdapter: string; }
export function projectHealthResult(
  request: { expectedRevisions: Revisions; conversationId?: string },
  result: { status: PersonalChromeHealthStatus; errorCode?: string; observedRevisions?: Revisions },
): { status: PersonalChromeHealthStatus; errorCode?: string };
