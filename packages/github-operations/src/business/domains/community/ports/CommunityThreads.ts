/** The workflow needs only thread existence and creation. The implementation
 * must bind userId to the authenticated Host caller before invoking SDK threads;
 * business input is never an authentication source. */
export interface CommunityThreads {
  get(threadId: string): Promise<{ id: string; title?: string | null; deletedAt?: number } | null>;
  create(userId: string, title: string, caseId: string): Promise<{ id: string }>;
}
