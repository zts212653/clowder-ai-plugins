import type {
  PluginActionContext,
  PluginMessage,
  PluginTaskReadItem,
  PluginThreadMessage,
  PluginThreadSummary,
} from '@clowder-ai/plugin-sdk';
import type { SuperagentHost } from '../src/runtime.js';

export function fixture() {
  const rows = new Map<string, { revision: number; value: unknown }>();
  let revision = 0;
  const threads = new Map<string, PluginThreadSummary>(
    ['source-a', 'source-b', 'outside'].map((id) => [
      id,
      {
        id,
        title: id,
        deepLinkUrl: `http://localhost/?threadId=${id}`,
        createdAt: 1,
        lastActiveAt: 1,
        preferredCats: [],
        featureRefs: [],
        projectRef: '/isolated/sample',
      },
    ]),
  );
  const tasks = new Map<string, PluginTaskReadItem>();
  const sent = new Map<string, Parameters<SuperagentHost['messaging']['send']>[0] & { messageId: string }>();
  const subscriptions = new Set<string>();
  const history = new Map<string, PluginThreadMessage[]>();
  const messages = new Map<string, PluginMessage>();
  const host: SuperagentHost = {
    pluginInstanceId: 'installed-superagent',
    config: { get: async () => undefined },
    members: {
      list: async () =>
        ['coordinator', 'worker'].map((catId) => ({
          catId,
          displayName: catId,
          defaultModel: 'test',
          available: true,
        })),
      get: async (catId) => ({
        catId,
        displayName: catId,
        defaultModel: 'test',
        available: true,
      }),
    },
    log() {},
    storage: {
      get: async (key) => structuredClone(rows.get(key)),
      set: async (key, value) => {
        rows.set(key, { revision: ++revision, value: structuredClone(value) });
        return { revision };
      },
      compareAndSet: async (key, expected, value) => {
        if ((rows.get(key)?.revision ?? null) !== expected) return { applied: false };
        rows.set(key, { revision: ++revision, value: structuredClone(value) });
        return { applied: true, revision };
      },
    },
    threads: {
      get: async (id) => threads.get(id) ?? null,
      list: async () => [...threads.values()],
      readMessages: async (id) => history.get(id) ?? [],
      create: async (input) => {
        const id = `thread-${threads.size}`;
        const thread = {
          id,
          title: input.title,
          deepLinkUrl: `http://localhost/?threadId=${id}`,
          createdAt: 1,
          lastActiveAt: 1,
          preferredCats: [],
          featureRefs: [],
          projectRef: '/isolated/sample',
        };
        threads.set(id, thread);
        return thread;
      },
      update: async (id, patch) => {
        const previous = threads.get(id);
        if (!previous) throw new Error('Unknown thread');
        const next = { ...previous, ...patch };
        threads.set(id, next);
        return next;
      },
    },
    messaging: {
      get: async (id) => messages.get(id) ?? null,
      subscribe: async ({ threadId }) => {
        subscriptions.add(threadId);
      },
      unsubscribe: async ({ threadId }) => {
        subscriptions.delete(threadId);
      },
      send: async (input) => {
        const key = `${input.threadId}:${input.idempotencyKey}`;
        const existing = sent.get(key);
        const message = existing ?? {
          ...input,
          messageId: `message-${sent.size}`,
        };
        sent.set(key, message);
        return { messageId: message.messageId, threadId: input.threadId };
      },
    },
    tasks: {
      get: async (selector) =>
        'id' in selector
          ? (tasks.get(selector.id!) ?? null)
          : ([...tasks.values()].find((task) => task.subjectKey === selector.subjectKey) ?? null),
      list: async () => [...tasks.values()],
      create: async (input) => {
        const previous = [...tasks.values()].find((task) => task.subjectKey === input.subjectKey);
        if (previous) return previous;
        const task: PluginTaskReadItem = {
          id: `task-${tasks.size}`,
          kind: input.kind ?? 'work',
          threadId: input.threadId,
          subjectKey: input.subjectKey ?? null,
          title: input.title,
          ownerCatId: input.ownerCatId ?? null,
          status: 'todo',
          why: input.why ?? '',
          createdBy: 'system',
          createdAt: 1,
          updatedAt: 1,
          userId: 'owner',
          ...(input.entrustedWork
            ? {
                entrustedWork: {
                  revision: 1,
                  closure: { state: 'open' },
                  admission: {
                    sourceRefs: [`message:${input.entrustedWork.sourceMessageId}`],
                  },
                },
              }
            : {}),
        };
        tasks.set(task.id, task);
        return task;
      },
      update: async (id, patch) => {
        const task = tasks.get(id);
        if (!task) return null;
        const next = {
          ...task,
          ...(patch.status ? { status: patch.status } : {}),
          ...(task.entrustedWork
            ? {
                entrustedWork: {
                  ...task.entrustedWork,
                  revision: task.entrustedWork.revision + 1,
                  ...('closure' in (patch.entrustedWork ?? {}) ? { closure: { state: 'satisfied' } } : {}),
                },
              }
            : {}),
        };
        tasks.set(id, next);
        return next;
      },
    },
  };
  const preferences = {
    v: 1,
    enabled: true,
    name: '我的助手',
    coordinatorId: 'coordinator',
    workerIds: ['worker'],
    threadIds: ['source-a', 'source-b'],
    responsibility: 'Investigate, implement and verify entrusted sample work. Ask for decisions.',
  };
  const seed = () => host.storage.set('preferences', preferences);
  const caller = (threadId: string, catId = 'coordinator'): PluginActionContext => ({
    catId,
    threadId,
    userId: 'owner',
    invocationId: `invocation-${threadId}`,
    assertCurrent: async () => {},
  });
  return {
    host,
    rows,
    threads,
    tasks,
    sent,
    subscriptions,
    history,
    messages,
    preferences,
    seed,
    caller,
  };
}

export function event(deliveryId: string, threadId = 'source-a', text = '请修复导出，再准备发布说明。') {
  return {
    kind: 'message',
    reason: 'subscription',
    deliveryId,
    threadId,
    envelope: {
      messageId: `source-${deliveryId}`,
      threadId,
      revision: 1,
      actor: { kind: 'user', id: 'owner' },
      audience: { kind: 'public' },
      occurredAt: '2026-11-03T17:00:00.000Z',
      payload: {
        provenance: {
          origin: { kind: 'host' },
          epistemicStatus: 'observation',
        },
        elements: [{ elementId: 'text', kind: 'text', payload: { text } }],
      },
    },
  };
}
