import { entityDispatchSchema } from '@clowder-ai/plugin-memory-contract/entity';
import { EntityMemoryLifecycleStore } from '../entity/EntityMemoryLifecycleStore.js';
import { EntitySurfaceConflictError, type StoredEntityRecord, entitySourceRevision } from '../entity/EntityRegistry.js';
import { isEntityVisibleToUser } from '../entity/entity-conflict-resolution.js';
import type { MemoryHostPorts } from '../host-port.js';
import type { openMemoryStorage } from '../open-memory-storage.js';

function withRevision(entity: StoredEntityRecord) {
  return { ...entity, revision: entitySourceRevision(entity) };
}

export function createEntityDispatch(
  storage: Pick<Awaited<ReturnType<typeof openMemoryStorage>>, 'db' | 'runWrite'>,
  source: MemoryHostPorts['memorySource'],
) {
  const entities = new EntityMemoryLifecycleStore(storage.db);
  return async (value: unknown) => {
    const request = entityDispatchSchema.parse(value);
    const { userId: ownerUserId, viewer } = await source.caller();
    if (viewer.type !== 'user') throw new Error('entity_owner_scope_required');
    const visible = (entity: StoredEntityRecord) => isEntityVisibleToUser(entity.visibilityScope, ownerUserId);
    switch (request.operation) {
      case 'entity.list':
        return entities.list().filter(visible).map(withRevision);
      case 'entity.get': {
        const current = entities.get(request.input.entityId);
        return current && visible(current) ? withRevision(current) : null;
      }
      case 'entity.action_evidence':
        return entities.getOwnerActionEvidence(request.input.entityId, ownerUserId, request.input.requestId);
      case 'entity.mutate':
        return storage.runWrite(async () => {
          const { entityId, command, updatedAt } = request.input;
          await source.assertCurrent();
          const current = entities.get(entityId);
          if (!current || !visible(current)) return { outcome: 'not_available' as const };
          const input = { ownerUserId, entityId, updatedAt, requestId: command.requestId, expectedRevision: command.expectedRevision };
          try {
            const result = command.action === 'correct'
              ? entities.correct({ ...input, patch: command.patch })
              : command.action === 'retire' ? entities.retire(input) : entities.hardForget(input);
            return result.outcome === 'applied' ? { ...result, entity: withRevision(result.entity) } : result;
          } catch (error) {
            if (error instanceof EntitySurfaceConflictError) return { outcome: 'conflict' as const };
            throw error;
          }
        });
    }
  };
}
