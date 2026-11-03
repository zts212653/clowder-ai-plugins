import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { workerInstructions } from './instructions.js';
import type { SuperagentHost } from './runtime.js';
import {
  editQueue,
  inboxSchema,
  type Preferences,
  type planSchema,
  questionSchema,
  read,
  records,
  type WorkLink,
  workSchema,
} from './state.js';

export function send(host: SuperagentHost, threadId: string, key: string, content: string, workerId?: string) {
  return host.messaging.send({
    threadId,
    identity: 'superagent',
    idempotencyKey: key,
    ...(workerId ? { wake: { catId: workerId, exact: true as const } } : {}),
    payload: {
      provenance: { epistemicStatus: 'observation' },
      elements: [{ elementId: 'content', kind: 'text', payload: { text: content } }],
    },
  });
}

export async function findWork(host: SuperagentHost, workId: string) {
  const task = await host.tasks.get({ id: workId });
  if (!task?.entrustedWork) throw new Error('Canonical Work unavailable');
  const prefix = `superagent:${host.pluginInstanceId}:`;
  if (!task.subjectKey?.startsWith(prefix)) throw new Error('Unknown Superagent Work');
  const key = task.subjectKey.slice(prefix.length);
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid Superagent Work identity');
  const work = await read(host, `work:${key}`, workSchema);
  if (!work || work.taskId !== task.id) throw new Error('Unknown Superagent Work');
  if (task.threadId !== work.threadId || task.ownerCatId !== work.workerId)
    throw new Error('Canonical Work owner changed');
  return { work, task };
}

export async function publish(
  host: SuperagentHost,
  mainThreadId: string,
  work: Pick<WorkLink, 'sourceThreadId' | 'taskId'>,
  key: string,
  content: string,
  question = false,
) {
  const original = await send(host, work.sourceThreadId, `${key}:source`, content);
  if (mainThreadId !== work.sourceThreadId)
    await send(host, mainThreadId, `${key}:main`, `${content}\n原会话：${work.sourceThreadId}`);
  if (question) {
    await host.storage.compareAndSet(`question:${key}`, null, {
      id: key,
      workId: work.taskId,
      sourceThreadId: work.sourceThreadId,
      content,
      resolved: false,
    });
    await editQueue(host, 'questions', key, true);
  }
  return original;
}

export async function applyPlan(
  host: SuperagentHost,
  preferences: Preferences,
  mainThreadId: string,
  plan: z.infer<typeof planSchema>,
) {
  const inbox = await read(host, `inbox:${plan.eventId}`, inboxSchema);
  if (!inbox) throw new Error('Source event unavailable');
  const answeredQuestions: z.infer<typeof questionSchema>[] = [];
  for (const [index, decision] of plan.decisions.entries()) {
    const key = createHash('sha256')
      .update(JSON.stringify([host.pluginInstanceId, plan.eventId, index]))
      .digest('hex');
    if ((decision.kind === 'start' || decision.kind === 'ignore') && decision.questionId) {
      const question = await read(host, `question:${decision.questionId}`, questionSchema);
      if (!question || question.workId || inbox.delivery.envelope.actor.kind !== 'user')
        throw new Error('Only a human answer can resolve an intake question');
      answeredQuestions.push(question);
    }
    if (decision.kind === 'ignore') continue;
    if (decision.kind === 'ask' && !decision.workId) {
      await publish(host, mainThreadId, { sourceThreadId: inbox.delivery.threadId }, key, decision.content, true);
      continue;
    }
    if (decision.kind === 'start') {
      if (!preferences.workerIds.includes(decision.workerId)) throw new Error('Worker is outside configured scope');
      let work = await read(host, `work:${key}`, workSchema);
      if (!work) {
        const thread = await host.threads.create({
          title: decision.title,
          parentThreadId: inbox.delivery.threadId,
          participants: [decision.workerId],
        });
        work = {
          key,
          title: decision.title,
          outcome: decision.outcome,
          workerId: decision.workerId,
          threadId: thread.id,
          sourceThreadId: inbox.delivery.threadId,
          sourceMessageId: inbox.delivery.envelope.messageId,
        };
        await host.storage.set(`work:${key}`, work);
      }
      await editQueue(host, 'works', key, true);
      const source = await send(
        host,
        work.threadId,
        `${key}:admission`,
        `Superagent 已接住：${work.title}\n${work.outcome}\n原文引用 message:${work.sourceMessageId}（会话 ${work.sourceThreadId}）。`,
      );
      if (!work.taskId) {
        const task = await host.tasks.create(
          {
            kind: 'work',
            subjectKey: `superagent:${host.pluginInstanceId}:${key}`,
            title: work.title,
            ownerCatId: work.workerId,
            threadId: work.threadId,
            entrustedWork: {
              sourceMessageId: source.messageId,
              intendedOutcome: work.outcome,
              closure: {
                condition: '用户接受交付结果',
                expectedSignal: 'explicit-owner-acceptance',
              },
            },
          },
          { onConflict: 'update' },
        );
        work = { ...work, taskId: task.id };
        await host.storage.set(`work:${key}`, work);
      }
      await host.messaging.subscribe({
        threadId: work.threadId,
        method: 'superagent.observe',
      });
      await send(host, work.threadId, `${key}:execute`, workerInstructions(work), work.workerId);
      continue;
    }
    const { work, task } = await findWork(host, decision.workId!);
    if (decision.kind === 'accept' && task.entrustedWork?.closure.state === 'satisfied') continue;
    if (task.entrustedWork?.closure.state !== 'open') throw new Error('Work is already terminal');
    if (decision.kind === 'follow_up') {
      const question = decision.questionId
        ? await read(host, `question:${decision.questionId}`, questionSchema)
        : undefined;
      if (decision.questionId && (!question || question.workId !== work.taskId))
        throw new Error('Question does not belong to this Work');
      await send(
        host,
        work.threadId,
        `${key}:follow-up`,
        `沿 Task ${work.taskId} 继续，原反馈 message:${inbox.delivery.envelope.messageId}：\n${decision.content}`,
        work.workerId,
      );
      if (decision.questionId) {
        await host.storage.set(`question:${question!.id}`, {
          ...question!,
          resolved: true,
        });
        await editQueue(host, 'questions', question!.id, false);
      }
    } else if (decision.kind === 'ask' || decision.kind === 'deliver') {
      const message = await publish(
        host,
        mainThreadId,
        work,
        key,
        `${work.title}：${decision.content}`,
        decision.kind === 'ask',
      );
      await host.tasks.update(task.id, {
        status: 'blocked',
        entrustedWork: {
          expectedRevision: task.entrustedWork!.revision,
          progress: {
            summary: decision.content,
            nextStep: decision.kind === 'ask' ? '等待用户决定' : '等待用户验收',
            sourceRef: `message:${message.messageId}`,
          },
        },
      });
    } else if (decision.kind === 'accept') {
      if (inbox.delivery.envelope.actor.kind !== 'user' || inbox.delivery.envelope.actor.id !== task.userId)
        throw new Error('Work acceptance requires its human owner source');
      await host.tasks.update(task.id, {
        entrustedWork: {
          expectedRevision: task.entrustedWork!.revision,
          closure: {
            state: 'satisfied',
            condition: '用户接受交付结果',
            expectedSignal: 'explicit-owner-acceptance',
            evidenceRefs: [`message:${inbox.delivery.envelope.messageId}`],
          },
        },
      });
      for (const question of (await records(host, 'question:', questionSchema)).filter(
        (q) => q.workId === work.taskId && !q.resolved,
      )) {
        await host.storage.set(`question:${question.id}`, {
          ...question,
          resolved: true,
        });
        await editQueue(host, 'questions', question.id, false);
      }
      await editQueue(host, 'works', work.key, false);
    }
  }
  for (const question of answeredQuestions) {
    await host.storage.set(`question:${question.id}`, { ...question, resolved: true });
    await editQueue(host, 'questions', question.id, false);
  }
  await host.storage.set(`plan:${plan.eventId}`, { ...plan, applied: true });
  await host.storage.set(`inbox:${plan.eventId}`, { ...inbox, phase: 'done' });
  await editQueue(host, 'inbox', plan.eventId, false);
}
