import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FeedbackService } from '../src/service.js';
import { fixture } from './service-fixture.js';

function analysisFixture() {
  const f = fixture();
  const effects: string[] = [];
  const thread = { id: 'diagnostic-thread', title: '反馈分析', projectRef: f.host.dataPath, deepLinkUrl: 'https://local.test/thread/diagnostic-thread' };
  Object.assign(f.host, {
    runtimeInfo: { get: async () => ({ version: 'test', platform: 'win32', architecture: 'x64', nodeVersion: '22', projectRoot: f.host.dataPath, logDirectory: f.host.dataPath }) },
    members: { list: async () => [{ catId: 'configured-cat', displayName: '本地伙伴', available: true, defaultModel: 'configured-model' }], get: async () => ({ catId: 'configured-cat', available: true }) },
    threads: { list: async () => [], get: async () => thread, create: async (input: { projectRef?: string }) => { effects.push(`create:${input.projectRef}`); return thread; } },
    messaging: { subscribe: async () => { effects.push('subscribe'); }, unsubscribe: async () => { effects.push('unsubscribe'); }, send: async (input: { wake: { catId: string }; payload: unknown }) => { effects.push(`wake:${input.wake.catId}`); return { messageId: 'request-message', threadId: thread.id }; } },
  });
  const call = (input: unknown) => f.call(input) as Promise<Record<string, unknown>>;
  return { ...f, effects, call, thread };
}

test('analysis uses the configured ordinary member, returns promptly and survives reopening', async () => {
  const f = analysisFixture();
  const prepared = await f.call({ op: 'prepare-analysis', report: { title: '启动失败', body: 'api_key=private-value', attachments: [] }, projectRef: f.host.dataPath });
  assert.ok(!String(prepared.material).includes('private-value'));
  assert.deepEqual(f.effects, [`create:${f.host.dataPath}`]);
  const started = await f.call({ op: 'analyze', clientId: 'configured-cat', hash: prepared.hash, confirmed: true });
  assert.equal((started.analysis as { state: string }).state, 'running');
  assert.deepEqual(f.effects, [`create:${f.host.dataPath}`, 'subscribe', 'wake:configured-cat']);
  const reopened = await f.call({ op: 'bootstrap' });
  assert.equal((reopened.analysis as { state: string }).state, 'running');
  assert.deepEqual(await f.service.receiveDelivery({ kind: 'execution_status', deliveryId: 'start', threadId: f.thread.id, state: 'started', replyTo: 'request-message', executionId: 'execution-1' }), { deliveryId: 'start' });
  await f.service.receiveDelivery({ kind: 'message', deliveryId: 'answer', threadId: f.thread.id, executionId: 'execution-1', envelope: { actor: { kind: 'cat', id: 'configured-cat' }, payload: { elements: [{ kind: 'text', payload: { text: JSON.stringify({ title: '启动失败', body: '## 初步分析\n尚未定位。token=private-output' }) } }] } } });
  const waiting = await f.call({ op: 'analysis-status' });
  assert.equal((waiting.analysis as { state: string }).state, 'running');
  await f.service.receiveDelivery({ kind: 'execution_status', deliveryId: 'end', threadId: f.thread.id, state: 'settled', chainDone: true, outcome: 'completed', executionId: 'execution-1' });
  const result = (await f.call({ op: 'analysis-status' })).analysis as { state: string; body: string };
  assert.equal(result.state, 'ready');
  assert.ok(!result.body.includes('private-output'));
});

test('missing reports and late results are explicit; direct feedback remains independent', async () => {
  const f = analysisFixture();
  const prepared = await f.call({ op: 'prepare-analysis', report: { title: '失败', body: '无法运行', attachments: [] } });
  await f.call({ op: 'analyze', clientId: 'configured-cat', hash: prepared.hash, confirmed: true });
  await f.service.receiveDelivery({ kind: 'execution_status', deliveryId: 'start', threadId: f.thread.id, state: 'started', replyTo: 'request-message', executionId: 'execution-2' });
  await f.service.receiveDelivery({ kind: 'execution_status', deliveryId: 'end', threadId: f.thread.id, state: 'settled', chainDone: true, outcome: 'completed', executionId: 'execution-2' });
  assert.equal(((await f.call({ op: 'analysis-status' })).analysis as { state: string }).state, 'failed');
  await f.call({ op: 'cancel-analysis' });
  await f.service.receiveDelivery({ kind: 'execution_status', deliveryId: 'late', threadId: f.thread.id, state: 'started', replyTo: 'request-message', executionId: 'old' });
  assert.equal(((await f.call({ op: 'analysis-status' })).analysis as { state: string }).state, 'cancelled');
  await f.call({ op: 'save', targetId: 'clowder', report: { title: '直接反馈', body: '不依赖分析', attachments: [] } });
});

test('plugin collects bounded log evidence and redacts it before any member invocation', async () => {
  const f = analysisFixture();
  await mkdir(f.host.dataPath, { recursive: true });
  await writeFile(join(f.host.dataPath, 'api.log'), JSON.stringify({ time: Date.now(), level: 50, msg: 'E_TIMEOUT api_key=private-log', err: { stack: 'stack-canary' } }));
  await writeFile(join(f.host.dataPath, 'auth.json'), 'credential-file-canary');
  const prepared = await f.call({ op: 'prepare-analysis', report: { title: '启动失败', body: '用户现象', attachments: [] }, logs: true });
  assert.match(String(prepared.material), /E_TIMEOUT/);
  assert.ok(!/private-log|stack-canary|credential-file-canary/.test(String(prepared.material)));
  await assert.rejects(f.call({ op: 'analyze', clientId: 'configured-cat', hash: prepared.hash }), /确认/);
  assert.ok(!f.effects.some(effect => effect.startsWith('wake:')));
});

test('a broken Client subscription cannot block reopening direct feedback', async () => {
  const f = analysisFixture();
  const prepared = await f.call({ op: 'prepare-analysis', report: { title: '失败', body: '无法运行', attachments: [] } });
  await f.call({ op: 'analyze', clientId: 'configured-cat', hash: prepared.hash, confirmed: true });
  f.host.messaging!.subscribe = async () => { throw new Error('subscriber unavailable'); };
  const reopened = await f.call({ op: 'bootstrap' });
  assert.ok(Array.isArray(reopened.targets));
  assert.equal((reopened.analysis as { state: string }).state, 'failed');
  await f.call({ op: 'save', targetId: 'clowder', report: { title: '直接反馈', body: '无需可用 Client', attachments: [] } });
});

test('unknown thread creation is recorded before the effect and not retried blindly', async () => {
  const f = analysisFixture(); let creates = 0;
  const create = f.host.threads!.create;
  f.host.threads!.create = async input => { creates++; await create(input); throw new Error('response lost after create'); };
  const input = { op: 'prepare-analysis', report: { title: '失败', body: '无法运行', attachments: [] } };
  await assert.rejects(f.call(input), /response lost/);
  await assert.rejects(f.call(input), /待核对/);
  assert.equal(creates, 1);
  assert.equal(((await f.call({ op: 'bootstrap' })).analysis as { state: string }).state, 'preparing');
});

test('a cold plugin activation reports an unverifiable old run as interrupted', async () => {
  const f = analysisFixture();
  const prepared = await f.call({ op: 'prepare-analysis', report: { title: '失败', body: '无法运行', attachments: [] } });
  const resumed = new FeedbackService(f.host);
  const pending = await resumed.dispatch({ op: 'bootstrap',feedbackId:f.feedbackId() }, f.ctx) as { analysis: { state: string } };
  assert.equal(pending.analysis.state, 'prepared');
  const started = await resumed.dispatch({ op: 'analyze',feedbackId:f.feedbackId(), clientId: 'configured-cat', hash: prepared.hash, confirmed: true }, f.ctx) as { analysis: { state: string } };
  assert.equal(started.analysis.state, 'running');
  const restarted = new FeedbackService(f.host);
  const reopened = await restarted.dispatch({ op: 'analysis-status',feedbackId:f.feedbackId() }, f.ctx) as { analysis: { state: string; threadUrl: string } };
  assert.equal(reopened.analysis.state, 'interrupted');
  assert.equal(reopened.analysis.threadUrl, f.thread.deepLinkUrl);
  assert.equal(f.effects.filter(effect => effect.startsWith('wake:')).length, 1);
});

test('owner interruption after create preserves the exact thread reference before stopping', async () => {
  const f = analysisFixture(); let expired = false;
  const create = f.host.threads!.create;
  f.host.threads!.create = async input => { const result = await create(input); expired = true; return result; };
  f.ctx.assertCurrent = async () => { if (expired) throw new Error('owner request expired'); };
  const input = { op: 'prepare-analysis', report: { title: '失败', body: '无法运行', attachments: [] } };
  await assert.rejects(f.call(input), /expired/);
  expired = false;
  const reopened = await f.call({ op: 'bootstrap' });
  assert.equal((reopened.analysis as { threadUrl: string }).threadUrl, f.thread.deepLinkUrl);
  await assert.rejects(f.call(input), /待核对/);
  assert.equal(f.effects.filter(effect => effect.startsWith('create:')).length, 1);
});

test('project logs cannot escape the selected project through a junction', async () => {
  const f = analysisFixture();
  const outside = join(f.host.dataPath, '..', `outside-feedback-${randomUUID()}`);
  await mkdir(f.host.dataPath, { recursive: true }); await mkdir(outside);
  await writeFile(join(outside, 'client.log'), JSON.stringify({ time: Date.now(), level: 50, msg: 'outside-business-canary' }));
  const link = join(f.host.dataPath, 'logs'); await symlink(outside, link, 'junction');
  try {
    const prepared = await f.call({ op: 'prepare-analysis', report: { title: '失败', body: '无法运行', attachments: [] }, logs: true });
    assert.ok(!String(prepared.material).includes('outside-business-canary'));
    assert.match(String(prepared.material), /覆盖存在缺口/);
  } finally { await (process.platform === 'win32' ? rmdir(link) : unlink(link)); }
});

test('durable completed replies recover a missed lifecycle event and legacy signed JSON without another wake', async () => {
  const f = analysisFixture();
  const prepared = await f.call({op:'prepare-analysis',report:{title:'测试反馈',body:'生成模板',attachments:[]}});
  await f.call({op:'analyze',clientId:'configured-cat',hash:prepared.hash,confirmed:true});
  Object.assign(f.host.threads!, {readMessages:async()=>[{
    id:'answer',timestamp:20,sender:{kind:'cat',catId:'configured-cat'},
    content:JSON.stringify({title:'反馈报告',body:'## 问题摘要\\n已分析\\n\\n[伙伴/model🐾]'})+'\n\n[伙伴/model🐾]',
    response:{executionId:'turn',inputMessageIds:['request-message'],status:'completed',startedAt:10,completedAt:20},
  }]});
  const restarted = new FeedbackService(f.host);
  const result = await restarted.dispatch({op:'bootstrap',feedbackId:f.feedbackId()},f.ctx) as {analysis:{state:string;title:string;body:string}};
  assert.equal(result.analysis.state,'ready');
  assert.equal(result.analysis.title,'反馈报告');
  assert.equal(result.analysis.body,'## 问题摘要\n已分析');
  assert.equal(f.effects.filter(effect=>effect.startsWith('wake:')).length,1);
});

test('durable progress stays associated with the exact request and invalid completed output stops waiting', async () => {
  const f = analysisFixture();
  const prepared = await f.call({op:'prepare-analysis',report:{title:'测试反馈',body:'分析问题',attachments:[]}});
  await f.call({op:'analyze',clientId:'configured-cat',hash:prepared.hash,confirmed:true});
  let inputMessageId = 'old-request'; let status = 'completed'; let content = '# 旧报告\n\n不能复用';
  Object.assign(f.host.threads!,{readMessages:async()=>[{id:'answer',timestamp:20,sender:{kind:'cat',catId:'configured-cat'},content,
    response:{executionId:'turn',inputMessageIds:[inputMessageId],status,startedAt:10}}]});
  assert.equal(((await f.call({op:'analysis-status'})).analysis as {state:string}).state,'running');
  inputMessageId='request-message'; status='processing'; content='正在分析';
  const progress=(await f.call({op:'analysis-status'})).analysis as {state:string;receivedChars:number};
  assert.equal(progress.state,'running'); assert.equal(progress.receivedChars,4);
  status='completed'; content='未生成有效报告';
  assert.equal(((await f.call({op:'analysis-status'})).analysis as {state:string}).state,'failed');
});

test('a late durable read cannot revive a cancelled analysis', async () => {
  const f = analysisFixture();
  const prepared=await f.call({op:'prepare-analysis',report:{title:'取消分析',body:'保留草稿',attachments:[]}});
  await f.call({op:'analyze',clientId:'configured-cat',hash:prepared.hash,confirmed:true});
  let release!: (value: unknown[])=>void;
  Object.assign(f.host.threads!,{readMessages:()=>new Promise(resolve=>{release=resolve;})});
  const pending=f.call({op:'analysis-status'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(((await f.call({op:'cancel-analysis'})).analysis as {state:string}).state,'cancelled');
  release([{id:'reply',timestamp:20,sender:{kind:'cat',catId:'configured-cat'},content:'# 已完成\n\n## 摘要\n旧结果',response:{executionId:'turn',inputMessageIds:['request-message'],status:'completed',startedAt:10}}]);
  assert.equal(((await pending).analysis as {state:string}).state,'cancelled');
});

test('history unavailability cannot prevent bootstrap or direct feedback', async () => {
  const f=analysisFixture();
  const prepared=await f.call({op:'prepare-analysis',report:{title:'诊断',body:'历史不可读',attachments:[]}});
  await f.call({op:'analyze',clientId:'configured-cat',hash:prepared.hash,confirmed:true});
  Object.assign(f.host.threads!,{readMessages:async()=>{throw new Error('thread unavailable');}});
  const reopened=await f.call({op:'bootstrap'});
  assert.ok(Array.isArray(reopened.targets));
  assert.equal((reopened.analysis as {state:string}).state,'failed');
  await f.call({op:'save',targetId:'clowder',report:{title:'直接反馈',body:'不依赖分析历史',attachments:[]}});
});

test('a previously rejected completed response can be recovered after a parser update without invoking again', async () => {
  const f=analysisFixture();
  const prepared=await f.call({op:'prepare-analysis',report:{title:'模板验收',body:'已完成但格式被拒绝',attachments:[]}});
  await f.call({op:'analyze',clientId:'configured-cat',hash:prepared.hash,confirmed:true});
  await f.service.receiveDelivery({kind:'execution_status',deliveryId:'started',threadId:f.thread.id,state:'started',replyTo:'request-message',executionId:'execution'});
  await f.service.receiveDelivery({kind:'execution_status',deliveryId:'settled',threadId:f.thread.id,state:'settled',chainDone:true,outcome:'completed',executionId:'execution'});
  assert.equal(((await f.call({op:'analysis-status'})).analysis as {state:string}).state,'failed');
  Object.assign(f.host.threads!,{readMessages:async()=>[{id:'reply',timestamp:20,sender:{kind:'cat',catId:'configured-cat'},content:'先说明分析依据。\n\n# 完整报告\n\n## 摘要\n合成验收。',
    response:{executionId:'turn',inputMessageIds:['request-message'],status:'completed',startedAt:10}}]});
  const result=await new FeedbackService(f.host).dispatch({op:'bootstrap',feedbackId:f.feedbackId()},f.ctx) as {analysis:{state:string;title:string}};
  assert.equal(result.analysis.state,'ready'); assert.equal(result.analysis.title,'完整报告');
  assert.equal(f.effects.filter(effect=>effect.startsWith('wake:')).length,1);
});
