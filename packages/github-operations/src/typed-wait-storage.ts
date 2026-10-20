import { createHash } from 'node:crypto';
import type { PluginStorageHost } from '@clowder-ai/plugin-sdk';
import type { AutomationState, TaskItem, WaitTerminationEventV1 } from './business/model/index.js';
import { automationGeneration, type ITaskStore } from './business/domains/github-signals/wait-ports.js';
import { mergeTaskAutomationState } from './business/domains/github-signals/TaskAutomationState.js';

const PREFIX = 'github.typed-wait.v1.';
const key = (id: string) => PREFIX + createHash('sha256').update(id).digest('hex');
export interface RegistrationRequest { readonly id: string; readonly fingerprint: string }
type RegistrationReceipt = RegistrationRequest & { readonly result: TaskItem };
type RecordV1 = {
  readonly schemaVersion: 1;
  readonly task: TaskItem;
  readonly registrations?: Readonly<Record<string, RegistrationReceipt>>;
  readonly lifecycleEvents?: readonly WaitTerminationEventV1[];
};

function requestKey(request: RegistrationRequest): string {
  if (!request.id || request.id.trim() !== request.id || request.id.length > 500 || !/^[a-f0-9]{64}$/.test(request.fingerprint)) {
    throw new Error('A stable registration request id and input fingerprint are required');
  }
  return createHash('sha256').update(request.id).digest('hex');
}

function withRegistration(record: RecordV1, request: RegistrationRequest | undefined): RecordV1 {
  if (!request) return record;
  return { ...record, registrations: { ...record.registrations,
    [requestKey(request)]: { ...request, result: structuredClone(record.task) } } };
}

function decode(value: unknown): TaskItem {
  const record = value as Partial<RecordV1> | null;
  if (!record || record.schemaVersion !== 1 || !record.task
    || typeof record.task.id !== 'string' || typeof record.task.updatedAt !== 'number'
    || !['pr_tracking', 'issue_tracking'].includes(record.task.kind)) {
    throw new Error('Invalid GitHub typed wait record');
  }
  return record.task;
}

/** Wait algorithms persist provider state here, never in Host TaskItem. */
export class GitHubWaitStorage implements ITaskStore {
  constructor(private readonly storage: PluginStorageHost, private readonly now = Date.now) {}

  /** Committed response, retained even after later registrations/collector writes. */
  async registrationResult(id: string, request: RegistrationRequest): Promise<TaskItem | null> {
    const name = requestKey(request);
    const entry = await this.storage.get(key(id));
    if (!entry) return null;
    if (decode(entry.value).id !== id) throw new Error('GitHub typed wait key mismatch');
    const receipt = (entry.value as RecordV1).registrations?.[name];
    if (!receipt) return null;
    if (receipt.id !== request.id || receipt.fingerprint !== request.fingerprint) {
      throw new Error('Registration request id reused with different input');
    }
    return structuredClone(receipt.result);
  }

  async lifecycleEvents(id: string): Promise<readonly WaitTerminationEventV1[]> {
    const entry = await this.storage.get(key(id));
    if (!entry) return [];
    if (decode(entry.value).id !== id) throw new Error('GitHub typed wait key mismatch');
    return structuredClone((entry.value as RecordV1).lifecycleEvents ?? []);
  }

  async appendLifecycleEvent(id: string, event: WaitTerminationEventV1): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const entry = await this.storage.get(key(id));
      if (!entry || decode(entry.value).id !== id || event.waitId !== id) throw new Error('Wait event task mismatch');
      const record = entry.value as RecordV1;
      const events = record.lifecycleEvents ?? [];
      if (events.some(item => item.eventId === event.eventId)) return;
      if ((await this.storage.compareAndSet(key(id), entry.revision,
        { ...record, lifecycleEvents: [...events, event] })).applied) return;
    }
    throw new Error('Wait event append raced; retry from durable outcome');
  }

  async get(id: string): Promise<TaskItem | null> {
    const entry = await this.storage.get(key(id));
    if (!entry) return null;
    const task = decode(entry.value);
    if (task.id !== id) throw new Error('GitHub typed wait key mismatch');
    return task;
  }

  async listByKind(kind: TaskItem['kind']): Promise<readonly TaskItem[]> {
    return Object.entries(await this.storage.list()).filter(([name]) => name.startsWith(PREFIX))
      .map(([, entry]) => decode(entry.value)).filter(task => task.kind === kind);
  }

  /** Caller supplies the SDK-created task projection; one immutable id per tracking history. */
  async create(task: TaskItem, registration?: RegistrationRequest): Promise<TaskItem | null> {
    decode({ schemaVersion: 1, task });
    const stored = structuredClone(task);
    const result = await this.storage.compareAndSet(key(task.id), null,
      withRegistration({ schemaVersion: 1, task: stored }, registration));
    return result.applied ? stored : null;
  }

  async replaceAutomationStateIfGeneration(id: string, input: {
    readonly expectedGeneration: number | null;
    readonly expectedUpdatedAt: number;
    readonly automationState: AutomationState;
    readonly status: TaskItem['status'];
    readonly registration?: RegistrationRequest;
    readonly lifecycleEvent?: WaitTerminationEventV1;
    readonly notification?: TaskItem['notification'];
  }): Promise<TaskItem | null> {
    const entry = await this.storage.get(key(id));
    if (!entry) return null;
    const task = decode(entry.value);
    if (task.id !== id || automationGeneration(task.automationState) !== input.expectedGeneration
      || task.updatedAt !== input.expectedUpdatedAt) return null;
    const next: TaskItem = {
      ...task, automationState: input.automationState, status: input.status,
      ...(input.notification ? { notification: input.notification } : {}),
      updatedAt: Math.max(this.now(), task.updatedAt + 1),
    };
    const record = entry.value as RecordV1;
    const events = record.lifecycleEvents ?? [];
    const nextRecord = withRegistration({
      ...record, task: next,
      ...(input.lifecycleEvent ? { lifecycleEvents: events.some(event => event.eventId === input.lifecycleEvent!.eventId)
        ? events : [...events, input.lifecycleEvent] } : {}),
    }, input.registration);
    const result = await this.storage.compareAndSet(key(id), entry.revision, nextRecord);
    return result.applied ? structuredClone(next) : null;
  }

  async patchAutomationState(id: string, patch: Partial<AutomationState>): Promise<TaskItem | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const task = await this.get(id);
      if (!task) return null;
      const state = task.automationState ?? {};
      const changed = await this.replaceAutomationStateIfGeneration(id, {
        expectedGeneration: automationGeneration(state), expectedUpdatedAt: task.updatedAt,
        automationState: mergeTaskAutomationState(state, patch) ?? {}, status: task.status,
      });
      if (changed) return changed;
    }
    throw new Error('GitHub collector state changed concurrently; observation must be retried');
  }
}
