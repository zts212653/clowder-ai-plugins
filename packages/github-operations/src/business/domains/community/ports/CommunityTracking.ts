import type { AutomationState, TaskItem } from '../../../model/index.js';

/** Package-owned collection view. Provider cursors belong here, not in a Host
 * Task. A case route creates collection work, never a native invocation receipt
 * or typed-wait authority. The production adapter must use SDK task/CAS edges
 * where a Host task exists and private storage for these provider fields. */
export interface CommunityTracking {
  listByKind(kind: TaskItem['kind']): Promise<readonly TaskItem[]>;
  getBySubject(subjectKey: string): Promise<TaskItem | null>;
  upsertBySubject(input: {
    kind: 'pr_tracking' | 'issue_tracking'; subjectKey: string; threadId: string;
    ownerCatId: string; title: string; why: string; createdBy: string;
    userId?: string; automationState?: AutomationState; routeSourceEventId?: string;
  }): Promise<TaskItem>;
  delete(id: string): Promise<boolean>;
}
