import {
  changeCollectiveWorkTimeRequestSchema,
  changeCollectiveAgentWorkTimeRequestSchema,
  setCollectiveRoadmapTargetDateRequestSchema,
  type CollectiveCollaborationActor,
} from '../contracts/index.js';
import { humanActor, requireHumanCommand, requireWorkSource } from './collaboration-command-helpers.js';
import { changeCollectiveWorkTime, setCollectiveRoadmapTargetDate } from './collaboration-time.js';
import { requireCollectiveWork } from './collaboration-work.js';
import { assertConnectionCoordinates, requireAuthorizedHuman, requireConnection } from './connection-authority.js';
import { requireParticipant } from './participation-store.js';
import type { PersistentServiceState } from './persistence.js';
import { requireAcceptedWorkExecution } from './work-execution-authority.js';

export class CollectiveTimeStore {
  constructor(
    private readonly persistence: PersistentServiceState,
    private readonly now: () => number,
  ) {}

  async changeWork(sessionToken: string, unsafeInput: unknown) {
    const input = changeCollectiveWorkTimeRequestSchema.parse(unsafeInput);
    return this.persistence.transaction((state) => {
      const human = requireHumanCommand(state, sessionToken, input);
      return changeCollectiveWorkTime(state, input, humanActor(human), this.now());
    });
  }

  async changeAgentWork(credential: string, unsafeInput: unknown) {
    const input = changeCollectiveAgentWorkTimeRequestSchema.parse(unsafeInput);
    return this.persistence.transaction((state) => {
      const connection = requireConnection(state, credential, input.connectionId);
      assertConnectionCoordinates(state, connection, input);
      const human = requireAuthorizedHuman(state, connection);
      const work = requireCollectiveWork(state, input.collectiveId, input.workId);
      const source = requireWorkSource(state, input.collectiveId, work.sourceEventId);
      const participant = requireParticipant(state, {
        ...input,
        humanId: human.humanId,
        channelId: source.location.channelId,
      });
      if (input.action === 'set') requireAcceptedWorkExecution(state, work, this.now());
      const actor: CollectiveCollaborationActor = {
        kind: 'agent',
        humanId: human.humanId,
        humanDisplayName: human.displayName,
        connectionId: connection.connectionId,
        catId: participant.catId,
        displayName: participant.displayName,
      };
      return changeCollectiveWorkTime(state, input, actor, this.now());
    });
  }

  async setProjectTarget(sessionToken: string, unsafeInput: unknown) {
    const input = setCollectiveRoadmapTargetDateRequestSchema.parse(unsafeInput);
    return this.persistence.transaction((state) => {
      const human = requireHumanCommand(state, sessionToken, input);
      return setCollectiveRoadmapTargetDate(state, input, humanActor(human), this.now());
    });
  }
}
