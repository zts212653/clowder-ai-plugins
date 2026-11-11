import { isPluginDeliveryInput } from '@clowder-ai/plugin-contract';
import type { ModulePluginHostShape, PluginModuleActivationShape } from '@clowder-ai/plugin-sdk';
import { advanceInbox, clearRecoveredError, observe } from './inbox.js';
import { coordinatorInstructions } from './instructions.js';
import { createSettings } from './settings.js';
import {
  editQueue,
  inboxSchema,
  planSchema,
  preferencesSchema,
  questionSchema,
  queued,
  read,
  records,
  reportSchema,
  runtimeSchema,
  saveOnce,
  workSchema,
} from './state.js';
import { applyPlan, findWork, publish, send } from './work.js';

export type SuperagentHost = Pick<ModulePluginHostShape, 'pluginInstanceId' | 'config' | 'members' | 'log'> & {
  storage: Pick<ModulePluginHostShape['storage'], 'get' | 'set' | 'compareAndSet'>;
  messaging: Pick<ModulePluginHostShape['messaging'], 'get' | 'send' | 'subscribe' | 'unsubscribe'>;
  threads: Pick<ModulePluginHostShape['threads'], 'get' | 'list' | 'create' | 'update' | 'readMessages'>;
  tasks: Pick<ModulePluginHostShape['tasks'], 'get' | 'list' | 'create' | 'update'>;
};

export async function startSuperagent(host: SuperagentHost): Promise<PluginModuleActivationShape> {
  let stopped = false;
  let tail = Promise.resolve();
  let reconciliation = Promise.resolve();
  const subscribed = new Set<string>();
  const current = () => {
    if (stopped) throw new Error('Superagent stopped');
  };
  const preferences = async () => preferencesSchema.parse((await host.storage.get('preferences'))?.value ?? {});
  const reconcile = () => {
    const run = reconciliation.then(async () => {
      current();
      const pref = await preferences();
      let runtime = (await read(host, 'runtime', runtimeSchema)) ?? {};
      if (!runtime.mainThreadId && pref.coordinatorId) {
        const main = await host.threads.create({
          title: pref.name,
          participants: [pref.coordinatorId],
        });
        runtime = { ...runtime, mainThreadId: main.id };
        await host.storage.set('runtime', runtime);
      }
      if (runtime.mainThreadId && pref.coordinatorId) {
        const main = await host.threads.get(runtime.mainThreadId);
        if (!main) throw new Error('Bot conversation unavailable');
        if (main.title !== pref.name || JSON.stringify(main.preferredCats) !== JSON.stringify([pref.coordinatorId]))
          await host.threads.update(main.id, {
            title: pref.name,
            preferredCats: [pref.coordinatorId],
          });
      }
      const works = await records(host, 'work:', workSchema);
      const wanted = new Set([
        ...(pref.enabled || pref.started ? pref.threadIds : []),
        ...works.map((work) => work.threadId),
        ...(runtime.mainThreadId ? [runtime.mainThreadId] : []),
      ]);
      for (const id of [...subscribed].filter((id) => !wanted.has(id))) {
        await host.messaging.unsubscribe({ threadId: id });
        subscribed.delete(id);
      }
      for (const id of [...wanted].filter((id) => !subscribed.has(id))) {
        await host.messaging.subscribe({
          threadId: id,
          method: 'superagent.observe',
        });
        subscribed.add(id);
      }
      return { pref, runtime, works };
    });
    reconciliation = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  const tick = () => {
    const run = tail.then(async () => {
      current();
      const { pref, runtime } = await reconcile();
      if (!runtime.mainThreadId) return;
      for (const report of await queued(host, 'reports', 'report:', reportSchema)) {
        current();
        const key = `${report.invocationId}:${report.reportId}`;
        if (report.applied) {
          await editQueue(host, 'reports', key, false);
          continue;
        }
        const { work, task } = await findWork(host, report.workId);
        if (task.entrustedWork?.closure.state !== 'open') {
          await host.storage.set(`report:${key}`, { ...report, applied: true });
          await editQueue(host, 'reports', key, false);
          continue;
        }
        const message =
          report.kind === 'progress'
            ? await send(host, work.threadId, `${key}:progress`, report.content)
            : await publish(
                host,
                runtime.mainThreadId,
                work,
                key,
                `${work.title}：${report.content}`,
                report.kind === 'question' || report.kind === 'result',
              );
        if (task.entrustedWork?.closure.state === 'open')
          await host.tasks.update(task.id, {
            status: report.kind === 'progress' ? 'doing' : 'blocked',
            entrustedWork: {
              expectedRevision: task.entrustedWork.revision,
              progress: {
                summary: report.content,
                nextStep:
                  report.kind === 'result'
                    ? '等待用户验收'
                    : report.kind === 'question'
                      ? '等待用户决定'
                      : '沿原工作继续',
                sourceRef: `message:${message.messageId}`,
              },
            },
          });
        await host.storage.set(`report:${key}`, { ...report, applied: true });
        await editQueue(host, 'reports', key, false);
      }
      if (!pref.enabled || !pref.coordinatorId) return;
      for (const plan of await queued(host, 'plans', 'plan:', planSchema)) {
        current();
        if (!plan.applied) await applyPlan(host, pref, runtime.mainThreadId, plan);
        await editQueue(host, 'plans', plan.eventId, false);
      }
      current();
      await advanceInbox(host, pref, runtime.mainThreadId);
    });
    const completed = run.then(() => clearRecoveredError(host));
    tail = completed.then(
      () => undefined,
      async (error: unknown) => {
        host.log('error', 'Superagent deterministic processing failed', {
          reason: error instanceof Error ? error.message : 'unknown',
        });
        if (!stopped) {
          const runtime = (await read(host, 'runtime', runtimeSchema)) ?? {};
          await host.storage.set('runtime', {
            ...runtime,
            error: error instanceof Error ? error.message : '处理失败',
          });
        }
      },
    );
    return completed.then(
      () => undefined,
      async (error: unknown) => {
        await tail;
        throw error;
      },
    );
  };
  await reconcile();
  return {
    configRefresh: async () => {
      await reconcile();
    },
    actions: {
      ...createSettings(host, preferences, reconcile, current),
      async 'superagent.observe'(input) {
        current();
        if (!isPluginDeliveryInput(input)) throw new Error('Invalid Superagent delivery');
        const { pref, runtime } = await reconcile();
        await observe(host, input, pref, runtime.mainThreadId);
        return { deliveryId: input.deliveryId };
      },
      'superagent.tick': tick,
      async 'superagent.inspect'(_input, context) {
        current();
        if (!context || context.toolExecutionPolicy)
          throw new Error('Superagent requires an ordinary member invocation');
        await context.assertCurrent();
        const { pref, runtime, works } = await reconcile();
        const coordinator = context.catId === pref.coordinatorId && context.threadId === runtime.mainThreadId;
        const selected = coordinator
          ? works
          : works.filter((work) => work.workerId === context.catId && work.threadId === context.threadId);
        if (!coordinator && selected.length === 0) throw new Error('Invocation is outside Superagent work');
        const tasks = await Promise.all(
          selected.filter((work) => work.taskId).map((work) => host.tasks.get({ id: work.taskId! })),
        );
        const inbox = coordinator
          ? (await queued(host, 'inbox', 'inbox:', inboxSchema)).filter((entry) => entry.phase !== 'done')
          : [];
        const sources = coordinator
          ? await Promise.all(
              [...new Set(inbox.map((entry) => entry.delivery.threadId))].map(async (threadId) => ({
                threadId,
                recent: await host.threads.readMessages(threadId, { limit: 20 }),
                existingWork: await host.tasks.list({ threadId, kind: 'work' }),
              })),
            )
          : [];
        return {
          instructions: coordinator ? coordinatorInstructions : '沿原 Task 执行，用 superagent_report 回报。',
          preferences: pref,
          works: selected,
          tasks,
          ...(coordinator
            ? {
                inbox,
                sources,
                questions: (await records(host, 'question:', questionSchema)).filter((q) => !q.resolved),
              }
            : {}),
        };
      },
      async 'superagent.route'(input, context) {
        current();
        const plan = planSchema.omit({ applied: true }).parse(input);
        const pref = await preferences();
        const runtime = await read(host, 'runtime', runtimeSchema);
        if (
          !context ||
          context.toolExecutionPolicy ||
          context.threadId !== runtime?.mainThreadId ||
          context.catId !== pref.coordinatorId
        )
          throw new Error('Only the configured coordinator can route work');
        await context.assertCurrent();
        const event = await read(host, `inbox:${plan.eventId}`, inboxSchema);
        if (!event) throw new Error('Unknown source event');
        const before = await read(host, `plan:${plan.eventId}`, planSchema);
        if (before) {
          if (JSON.stringify(before.decisions) !== JSON.stringify(plan.decisions))
            throw new Error('Superagent decision conflict');
        } else
          await saveOnce(host, `plan:${plan.eventId}`, {
            ...plan,
            applied: false,
          });
        if (!before?.applied) await editQueue(host, 'plans', plan.eventId, true);
        return { accepted: true, eventId: plan.eventId };
      },
      async 'superagent.report'(input, context) {
        current();
        const value = reportSchema.omit({ applied: true, invocationId: true }).parse(input);
        const { work } = await findWork(host, value.workId);
        if (
          !context ||
          context.toolExecutionPolicy ||
          context.threadId !== work.threadId ||
          context.catId !== work.workerId
        )
          throw new Error('Only the assigned worker can report this Work');
        await context.assertCurrent();
        const report = {
          ...value,
          applied: false,
          invocationId: context.invocationId,
        };
        await saveOnce(host, `report:${context.invocationId}:${value.reportId}`, report);
        await editQueue(host, 'reports', `${context.invocationId}:${value.reportId}`, true);
        if (value.kind !== 'progress')
          await host.storage.set(`terminal:${context.invocationId}`, {
            workId: value.workId,
          });
        return { accepted: true, workId: value.workId };
      },
      async 'superagent.view'() {
        current();
        const pref = await preferences();
        const runtime = await read(host, 'runtime', runtimeSchema);
        const ready =
          pref.coordinatorId && pref.threadIds.length && pref.workerIds.length && pref.responsibility.trim();
        // The console reads this through its webhook route: an HTTP response.
        return {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
          body: JSON.stringify({
            label: pref.name,
            threadId: runtime?.mainThreadId ?? null,
            status: runtime?.error ? 'error' : !ready ? 'setup' : pref.enabled ? 'listening' : 'paused',
            detail: runtime?.error,
            badgeCount: (await records(host, 'question:', questionSchema)).filter((q) => !q.resolved).length,
          }),
        };
      },
    },
    async stop() {
      stopped = true;
      await tail;
      await reconciliation;
      await Promise.all([...subscribed].map((threadId) => host.messaging.unsubscribe({ threadId })));
      subscribed.clear();
    },
  };
}
