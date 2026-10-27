import { collectiveConnectionCoordinatesSchema } from '../contracts/types/collective.js';
import {
  COLLECTIVE_PROJECT_ATTENTION_PRODUCER_ID,
  collectiveProjectAttentionActionRef,
  collectiveProjectAttentionItemSchema,
  collectiveProjectAttentionSubjectRef,
  type CollectiveProjectAttentionItem,
} from '../contracts/types/collective-project-attention.js';
import { assertConnectionCoordinates, requireAuthorizedHuman, requireConnection } from './connection-authority.js';
import type { PersistentServiceState } from './persistence.js';
import type { CollectiveProjectMaterialStore } from './project-material-store.js';

/** Source-owned pending judgments. This projection creates no task, reminder, date or external effect. */
export async function readProjectAttention(
  persistence: PersistentServiceState,
  materials: CollectiveProjectMaterialStore,
  credential: string,
  unsafe: unknown,
  now: number,
) {
  const input = collectiveConnectionCoordinatesSchema.parse(unsafe);
  const authorize = () => {
    const state = persistence.snapshot(),
      connection = requireConnection(state, credential, input.connectionId);
    assertConnectionCoordinates(state, connection, input);
    return { state, connection, human: requireAuthorizedHuman(state, connection) };
  };
  const { state, human } = authorize();
  const projects = Object.values(state.roadmaps).filter(
    (item) => item.collectiveId === input.collectiveId && item.status === 'active',
  );
  const items: CollectiveProjectAttentionItem[] = [],
    reasons: string[] = [];
  for (const project of projects) {
    const common = {
      ...input,
      producerId: COLLECTIVE_PROJECT_ATTENTION_PRODUCER_ID,
      roadmapId: project.roadmapId,
      projectTitle: project.title,
      channelId: project.sourceLocation.channelId,
      targetHumanId: human.humanId,
    };
    if (project.accountableHumanId === human.humanId) {
      const source = await materials.listForConnection(credential, { ...input, roadmapId: project.roadmapId });
      authorize();
      if (source.unavailable.length) reasons.push('collective_project_material_source_unavailable');
      if (source.pendingCount) {
        const pending = source.items.filter(
          (item) =>
            !item.disposition &&
            (item.material.clauses.length === 0 ||
              item.material.clauses.some((clause) => !item.decisions[clause.clauseId])),
        );
        const value = {
          ...common,
          kind: 'triage' as const,
          count: source.pendingCount,
          sinceAt: pending.map((item) => item.createdAt).sort()[0] ?? project.createdAt,
          expectedProducerRevision: project.revision + pending.reduce((total, item) => total + item.revision, 0),
        };
        items.push(
          collectiveProjectAttentionItemSchema.parse({
            ...value,
            subjectRef: collectiveProjectAttentionSubjectRef(value),
            actionRef: collectiveProjectAttentionActionRef(value),
          }),
        );
      }
    }
    const current = authorize().state;
    for (const workId of project.workIds) {
      const work = current.works[workId];
      if (
        !work ||
        work.accountableHumanId !== human.humanId ||
        ['proposed', 'declined', 'completed', 'cancelled'].includes(work.lifecycle)
      )
        continue;
      const value = {
        ...common,
        workId: work.workId,
        workRevision: work.revision,
        workTitle: work.title,
        expectedProducerRevision: work.revision,
      };
      const suggestions = work.timeSuggestions?.filter((item) => item.status === 'pending') ?? [];
      if (suggestions.length) {
        const row = {
          ...value,
          kind: 'date_suggestion' as const,
          count: suggestions.length,
          sinceAt: suggestions[0]!.at,
        };
        items.push(
          collectiveProjectAttentionItemSchema.parse({
            ...row,
            subjectRef: collectiveProjectAttentionSubjectRef(row),
            actionRef: collectiveProjectAttentionActionRef(row),
          }),
        );
      }
      const deadline = work.time?.businessDeadline;
      if (deadline && Date.parse(deadline.value) < now) {
        const row = { ...value, kind: 'overdue' as const, count: 1, sinceAt: deadline.value };
        items.push(
          collectiveProjectAttentionItemSchema.parse({
            ...row,
            subjectRef: collectiveProjectAttentionSubjectRef(row),
            actionRef: collectiveProjectAttentionActionRef(row),
          }),
        );
      }
    }
  }
  const fresh = authorize();
  return { identity: { ...input, authorizedHumanId: fresh.human.humanId }, items, reasons: [...new Set(reasons)] };
}
