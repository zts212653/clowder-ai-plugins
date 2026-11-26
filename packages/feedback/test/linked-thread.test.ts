import assert from 'node:assert/strict';
import test from 'node:test';
import { FeedbackService } from '../src/service.js';
import { fixture } from './service-fixture.js';
import type { Host } from '../src/types.js';

function linkedFixture() {
  const f = fixture();
  const thread = { id: 'existing-thread', title: '原会话', deepLinkUrl: 'https://local.test/thread/existing-thread', projectRef: f.host.dataPath, createdAt: 1, lastActiveAt: 10, featureRefs: [], preferredCats: [] };
  const rows: Awaited<ReturnType<NonNullable<NonNullable<Host['threads']>['readMessages']>>>[number][] = [];
  const sends: Parameters<NonNullable<Host['messaging']>['send']>[0][] = [];
  let creates = 0;
  Object.assign(f.host, {
    threads: {
      list: async ({ threadIds }: { threadIds?: string[] }) => !threadIds || threadIds.includes(thread.id) ? [thread] : [],
      get: async () => thread,
      getCats: async (id: string) => {
        assert.equal(id, thread.id);
        return { participants: [], routableNow: [{catId:'analyst'}], routableNotJoined:[{catId:'outside'}], notRoutable:[] };
      },
      create: async () => { creates++; return thread; },
      readMessages: async (id: string) => { assert.equal(id, thread.id); return rows; },
    },
    runtimeInfo: { get: async () => ({ version: 'test', platform: 'win32', architecture: 'x64', nodeVersion: '24', projectRoot: f.host.dataPath, logDirectory: f.host.dataPath }) },
    members: { get: async () => ({ available: true }), list: async () => ['analyst','outside'].map(catId=>({catId,available:true,displayName:catId,defaultModel:'test'})) },
    messaging: { subscribe: async () => assert.fail('linked runs use timeline readback'), unsubscribe: async () => assert.fail('do not unsubscribe shared threads'),
      send: async (input: (typeof sends)[number]) => { sends.push(input); return { messageId: 'send-' + sends.length, threadId: thread.id }; } },
  });
  const report = { kind: 'bug', title: '', body: '界面打不开', attachments: [] };
  const save = (linkedThreadId: string | null = thread.id) => f.call({ op: 'save', targetId: 'clowder', report, linkedThreadId });
  return { ...f, rows, sends, save, report, thread, threadCreates: () => creates };
}

test('analyzes inside the saved conversation and takes only the reply to this feedback request', async () => {
  const f = linkedFixture();
  const { journal } = await f.save();
  assert.equal(journal.linkedThread?.id, f.thread.id);
  const prepared = await f.call({ op: 'prepare-analysis', linkedThreadId: 'forged-thread', logs: false }) as unknown as { hash: string };
  await f.call({ op: 'analyze', clientId: 'analyst', hash: prepared.hash, confirmed: true });
  const reply = { id: 'answer', timestamp: 20, sender: { kind: 'cat', catId: 'analyst' }, content: '# bug: 已有结论\n\n## 初步分析\n证据齐全。', response: { executionId: 'turn', inputMessageIds: ['other-request'], status: 'completed', startedAt: 10 } } as const;
  f.rows.push(reply);
  const status = () => f.call({ op: 'analysis-status' }) as unknown as Promise<{analysis: {state: string; title?: string}}>;
  assert.equal((await status()).analysis.state, 'running');
  f.rows.push({ ...reply, id: 'correct', response: { ...reply.response, inputMessageIds: ['send-1'] } });
  assert.equal((await status()).analysis.title, 'bug: 已有结论');
  assert.equal(f.sends[0]?.threadId, f.thread.id);
  assert.equal(f.threadCreates(), 0);
});

test('imports only the selected existing reply, keeps linked history and sends back one verified Issue receipt', async () => {
  const f = linkedFixture();
  f.rows.push({ id: 'reply', timestamp: 20, sender: { kind: 'cat', catId: 'analyst' }, content: `之前已确认复现。secret=private-canary\n${f.thread.deepLinkUrl}\n${f.thread.id}`, response: { executionId: 'older', inputMessageIds: ['question'], status: 'completed', startedAt: 1 } },
    { id: 'unfinished', timestamp: 21, sender: { kind: 'cat', catId: 'analyst' }, content: 'pending-canary', response: { executionId: 'active', inputMessageIds: ['next'], status: 'processing', startedAt: 2 } });
  await assert.rejects(f.save('foreign-thread'), /不可访问/);
  const listed = await f.call({ op: 'list-threads' }) as unknown as { items: { id: string }[] };
  assert.deepEqual(listed.items.map(item => item.id), [f.thread.id]);
  const context = await f.call({ op: 'thread-context', threadId: f.thread.id }) as unknown as { messages: { id: string }[] };
  assert.deepEqual(context.messages.map(message => message.id), ['reply']);
  const saved = await f.call({ op: 'save', targetId: 'clowder', linkedThreadId: f.thread.id, sourceMessageId: 'reply', report: { kind: 'bug', attachments: [] } });
  assert.match(saved.journal.report.body, /之前已确认复现/);
  assert.doesNotMatch(saved.journal.report.body, /private-canary|pending-canary|existing-thread/);
  assert.equal(f.sends.length, 0);
  const digest = saved.journal.digest;
  await f.call({ op: 'approve', digest, confirmed: true });
  await assert.rejects(f.call({ op: 'sync-thread-issue', digest }), /核实/);
  await f.call({ op: 'submit', digest });
  const contextAfter = await f.call({ op: 'thread-context', threadId: f.thread.id }) as unknown as { feedback: { issueId: string }[] };
  assert.deepEqual(contextAfter.feedback.map(item => item.issueId), ['12']);
  await f.call({ op: 'sync-thread-issue', digest });
  await f.call({ op: 'sync-thread-issue', digest });
  assert.equal(f.creates(), 1);
  assert.equal(f.threadCreates(), 0);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0]?.wake, undefined);
  assert.match(JSON.stringify(f.sends[0]?.payload), /issues\/12/);
  assert.doesNotMatch(JSON.stringify(f.sends[0]?.payload), /private-canary|之前已确认复现/);
});

test('changing the linked conversation invalidates prepared material', async () => {
  const f = linkedFixture();
  await f.save();
  const prepared = await f.call({ op: 'prepare-analysis' }) as unknown as { hash: string };
  await f.save(null);
  await assert.rejects(f.call({ op: 'analyze', clientId: 'analyst', hash: prepared.hash, confirmed: true }), /重新准备/);
  assert.equal(f.sends.length, 0);
});

test('only members routable in the linked conversation can start its analysis', async () => {
  const f = linkedFixture();
  await f.save();
  const listed = await f.call({ op:'analysis-members' }) as unknown as { clients: {id: string}[] };
  assert.deepEqual(listed.clients.map(client=>client.id), ['analyst']);
  const prepared = await f.call({op:'prepare-analysis'}) as unknown as {hash: string};
  await assert.rejects(f.call({op:'analyze',clientId:'outside', hash:prepared.hash, confirmed:true}), /原会话/);
  assert.equal(f.sends.length, 0);
});

test('a verified receipt already sent to the conversation survives a journal write interruption', async () => {
  const f = linkedFixture();
  const { journal } = await f.save();
  const { digest } = journal;
  await f.call({op:'approve',digest,confirmed:true});
  await f.call({op:'submit',digest});
  Object.assign(f.host.messaging!,{
    findSent: async ({idempotencyKey}: {idempotencyKey:string}) => f.sends.some(sent=>sent.idempotencyKey===idempotencyKey)
      ? {threadId:f.thread.id,messageId:'send-1',content:'Issue #12',routedCatIds:[]} : null,
  });
  const cas = f.host.storage.compareAndSet;
  let fail = true;
  f.host.storage.compareAndSet = async (key, revision, value) => {
    if (fail && (value as {linkedIssueMessageId?:string})?.linkedIssueMessageId==='send-1') {
      fail = false;
      return {applied:false};
    }
    return cas(key,revision,value);
  };
  await assert.rejects(f.call({op:'sync-thread-issue',digest}), /另一个窗口/);
  const reopened = new FeedbackService(f.host,()=>f.adapter);
  const { revision } = await reopened.dispatch({op:'bootstrap',feedbackId:journal.id},f.ctx) as {revision:number};
  const result = await reopened.dispatch({op:'sync-thread-issue',feedbackId:journal.id,digest,revision},f.ctx) as {journal:{linkedIssueMessageId?:string}};
  assert.equal(result.journal.linkedIssueMessageId,'send-1');
  assert.equal(f.sends.length,1);
  assert.equal(f.creates(),1);
});

test('two feedbacks in the same conversation recover their own replies after reopening', async () => {
  const f = linkedFixture();
  const run = async (feedbackId: string) => {
    await f.call({ op:'save', targetId:'clowder', linkedThreadId:f.thread.id, report:f.report, feedbackId });
    const prepared = await f.call({ op:'prepare-analysis', feedbackId }) as unknown as { hash: string };
    await f.call({ op:'analyze', feedbackId, clientId:'analyst', hash:prepared.hash, confirmed:true });
  };
  await run('first');
  await run('second');
  f.rows.push({
    id:'combined', timestamp:19, sender:{kind:'cat',catId:'analyst'}, content:'# bug: 两条一起处理\n\n无法分别归属',
    response:{executionId:'combined-run',inputMessageIds:['send-1','send-2'],status:'completed',startedAt:10},
  });
  for (const feedbackId of ['first','second']) {
    const { analysis } = await f.call({op:'analysis-status',feedbackId}) as unknown as {analysis:{state:string;error:string;title?:string}};
    assert.equal(analysis.state,'failed');
    assert.match(analysis.error,/合并回复/);
    assert.equal(analysis.title,undefined);
  }
  f.rows.push(...['第一条结论','第二条结论'].map((title,index) => ({
    id:'reply-'+index, timestamp:20+index, sender:{kind:'cat' as const,catId:'analyst'}, content:`# bug: ${title}\n\n核实的结果`,
    response:{executionId:'execution-'+index,inputMessageIds:[`send-${index+1}`],status:'completed' as const,startedAt:10},
  })));
  const reopened = new FeedbackService(f.host, () => f.adapter);
  const first = await reopened.dispatch({ op:'bootstrap',feedbackId:'first' },f.ctx) as {analysis:{title:string}};
  const second = await reopened.dispatch({ op:'bootstrap',feedbackId:'second' },f.ctx) as {analysis:{title:string}};
  assert.equal(first.analysis.title, 'bug: 第一条结论');
  assert.equal(second.analysis.title, 'bug: 第二条结论');
  assert.equal(f.sends.length, 2);
  assert.equal(f.threadCreates(), 0);
});
