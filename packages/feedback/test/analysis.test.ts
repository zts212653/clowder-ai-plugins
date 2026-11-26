import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FeedbackService } from '../src/service.js';
import { diagnosticEnvironment } from '../src/diagnostic-environment.js';
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

test('activity tracks analysis outside the panel until its exact result is viewed', async () => {
  const f = analysisFixture();
  const activity = () => f.service.activity({...f.ctx, operation:'read'});
  const report = { title:'启动失败', body:'无法打开', attachments:[] };
  const prepared = await f.call({op:'prepare-analysis',report,projectRef:f.host.dataPath});
  assert.deepEqual(await activity(),{ running:0, unread:0 });
  const started = await f.call({op:'analyze',clientId:'configured-cat',hash:prepared.hash,confirmed:true});
  const runId = (started.analysis as { id:string }).id;
  assert.deepEqual(await activity(),{ running:1, unread:0 });
  const threadId = f.thread.id;
  const executionId = 'execution-activity';
  await f.service.receiveDelivery({kind:'execution_status',deliveryId:'start',threadId,executionId,state:'started',replyTo:'request-message'});
  await f.service.receiveDelivery({kind:'message',deliveryId:'answer',threadId,executionId,envelope:{
    actor:{kind:'cat',id:'configured-cat'},payload:{elements:[{kind:'text',payload:{text:'# bug: 启动失败\n\n已复现启动失败。'}}]},
  }});
  await f.service.receiveDelivery({kind:'execution_status',deliveryId:'end',threadId,executionId,state:'settled',chainDone:true,outcome:'completed'});
  assert.deepEqual(await activity(),{ running:0, unread:1 });
  const other = new FeedbackService(f.host, () => f.adapter);
  assert.deepEqual(await other.activity({...f.ctx,operation:'read'}),{ running:0, unread:1 });
  assert.deepEqual(await other.activity({...f.ctx,userId:'another-owner',operation:'read'}),{ running:0, unread:0 });
  await f.call({op:'bootstrap'});
  await f.call({op:'save',targetId:'clowder',report:{title:'bug: 启动失败',body:'已复现启动失败。',attachments:[]}});
  assert.deepEqual(await activity(),{ running:0, unread:1 });
  await f.call({op:'view-analysis',runId:'obsolete'});
  assert.deepEqual(await activity(),{ running:0, unread:1 });
  await f.call({op:'view-analysis',runId});
  assert.deepEqual(await activity(),{ running:0, unread:0 });
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

test('analysis names the ordinary project thread using a redacted one-line title', async () => {
  const f = analysisFixture();
  const calls: unknown[] = [];
  Object.assign(f.host.threads!, {
    create: async (input: unknown) => { calls.push(input); return f.thread; },
  });
  await f.call({
    op: 'prepare-analysis',
    report: { kind: 'bug', title: '崩溃 token=synthetic-value。额外细节', body: '用户现象', attachments: [] },
    projectRef: f.host.dataPath,
  });
  assert.deepEqual(calls, [{ title: '问题反馈：崩溃 token=[REDACTED]', projectRef: f.host.dataPath }]);
  assert.equal(f.effects.length, 0);
});

test('plugin collects bounded log evidence and redacts it before any member invocation', async () => {
  const f = analysisFixture();
  await mkdir(f.host.dataPath, { recursive: true });
  await writeFile(join(f.host.dataPath, 'api.log'), JSON.stringify({ time: Date.now(), level: 50, msg: 'E_TIMEOUT api_key=private-log', err: { stack: 'stack-canary' } }));
  await writeFile(join(f.host.dataPath, 'auth.json'), 'credential-file-canary');
  const prepared = await f.call({ op: 'prepare-analysis', report: { title: '启动失败', body: '用户现象', attachments: [] }, logs: true });
  assert.match(String(prepared.material), /E_TIMEOUT/);
  assert.match(String(prepared.material), /Windows.*win32/);
  assert.match(String(prepared.material), /运行形态：未能核实/);
  assert.match(String(prepared.material), /所选项目未发现 Clowder 源码/);
  assert.match(String(prepared.material), /随包排查指南/);
  assert.ok(!/private-log|stack-canary|credential-file-canary/.test(String(prepared.material)));
  await assert.rejects(f.call({ op: 'analyze', clientId: 'configured-cat', hash: prepared.hash }), /确认/);
  assert.ok(!f.effects.some(effect => effect.startsWith('wake:')));
});

test('an installed desktop collects current startup clues without source or arbitrary sibling logs', async t => {
  const f = analysisFixture();
  const runtimeRoot = join(f.host.dataPath, 'installed-app');
  const entrypoint = join(runtimeRoot, 'packages/api/dist/domains/plugin/execution-worker/bootstrap.js');
  const logRoot = join(f.host.dataPath, 'relocated/data/logs');
  const logDirectory = join(logRoot, 'api');
  const projectRoot = join(f.host.dataPath, 'unrelated-project');
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 60 * 60_000).toISOString();
  await Promise.all([
    mkdir(join(runtimeRoot, 'desktop-dist/resources'), { recursive: true }),
    mkdir(logDirectory, { recursive: true }),
    mkdir(projectRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(runtimeRoot, 'desktop-dist/resources/app.asar'), ''),
    writeFile(join(logDirectory, 'api.log'), JSON.stringify({ time: now, level: 50, msg: 'API_TEST_ERROR' })),
    writeFile(join(logRoot, 'main.log'), `[main ${now}] WINDOW_WARNING secret=desktop-canary\n[main ${old}] OLD_WARNING`),
    writeFile(join(logRoot, 'desktop.log'), `[${now}] API timeout\n[${now}] [api] env: ERROR=ENV_CANARY`),
    writeFile(join(logRoot, 'custom.log'), `[${now}] UNRELATED_ERROR`),
  ]);
  const oldEntry = process.argv[1];
  const oldStartup = process.env.CAT_CAFE_DESKTOP_STARTUP_ID;
  const oldRuntime = process.env.CAT_CAFE_RUNTIME_ROOT;
  t.after(() => {
    process.argv[1] = oldEntry!;
    if (oldStartup === undefined) delete process.env.CAT_CAFE_DESKTOP_STARTUP_ID;
    else process.env.CAT_CAFE_DESKTOP_STARTUP_ID = oldStartup;
    if (oldRuntime === undefined) delete process.env.CAT_CAFE_RUNTIME_ROOT;
    else process.env.CAT_CAFE_RUNTIME_ROOT = oldRuntime;
  });
  process.argv[1] = entrypoint;
  process.env.CAT_CAFE_DESKTOP_STARTUP_ID = 'startup-canary';
  process.env.CAT_CAFE_RUNTIME_ROOT = runtimeRoot;
  f.thread.projectRef = projectRoot;
  f.host.runtimeInfo!.get = async () => ({
    version: 'desktop-build', platform: 'win32', architecture: 'x64', nodeVersion: '24', projectRoot, logDirectory,
  });
  let sent = '';
  f.host.messaging!.send = async input => { sent = JSON.stringify(input); return { messageId: 'verified-message' }; };
  const prepared = await f.call({ op: 'prepare-analysis', report: { title: '窗口启动失败', body: '未显示窗口', attachments: [] }, logs: true });
  const material = String(prepared.material);
  assert.match(material, /桌面安装版（已核实打包资源）/);
  assert.match(material, /所选项目未发现 Clowder 源码/);
  assert.match(material, /E3 当前实例 API 日志[\s\S]*API_TEST_ERROR/);
  assert.match(material, /E4 当前桌面启动日志/);
  assert.match(material, /WINDOW_WARNING/);
  assert.match(material, /API timeout/);
  assert.match(material, /E5 所选项目 logs 目录[^\n]*\n此来源不存在/);
  assert.match(material, /# 桌面部署/);
  assert.doesNotMatch(material, /desktop-canary|OLD_WARNING|ENV_CANARY|UNRELATED_ERROR|startup-canary/);
  assert.ok(!material.includes(f.host.dataPath));
  await f.call({ op: 'analyze', clientId: 'configured-cat', hash: prepared.hash, confirmed: true });
  assert.ok(sent.includes(JSON.stringify(material).slice(1, -1)));
  const second = analysisFixture();
  second.host.runtimeInfo!.get = f.host.runtimeInfo!.get;
  const feature = await second.call({ op: 'prepare-analysis', report: { kind: 'feat', title: '改进建议', body: '示例', attachments: [] } });
  assert.doesNotMatch(String(feature.material), /API_TEST_ERROR|WINDOW_WARNING|随包排查指南/);
});

test('runtime identification separates macOS packaging, compiled Web and the selected source project', async () => {
  const f = analysisFixture();
  const app = join(f.host.dataPath, 'Clowder AI.app/Contents/Resources');
  const source = join(f.host.dataPath, 'different-checkout');
  await Promise.all([
    mkdir(app, { recursive: true }),
    mkdir(join(source, 'packages/api/src/domains/plugin/host-surface'), { recursive: true }),
    mkdir(join(source, 'packages/web/src/app'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(app, 'app.asar'), ''),
    writeFile(join(source, 'packages/api/src/domains/plugin/host-surface/plugin-neutral-host.ts'), ''),
    writeFile(join(source, 'packages/web/src/app/layout.tsx'), ''),
  ]);
  const environment = { version: 'build', platform: 'darwin', architecture: 'arm64', nodeVersion: '24', projectRoot: source, logDirectory: join(app, 'custom-logs') };
  const desktop = await diagnosticEnvironment(environment, source, { entrypoint: join(app, 'packages/api/dist/index.js'), desktopRoot: app });
  assert.match(desktop.facts, /macOS.*darwin.*arm64/);
  assert.match(desktop.facts, /桌面安装版/);
  assert.match(desktop.facts, /源码标记，版本对应关系待核实/);
  assert.match(desktop.facts, /非标准 API 日志布局/);
  assert.equal(desktop.desktopLogRoot, undefined);
  const web = await diagnosticEnvironment(environment, source, { entrypoint: join(source, 'packages/api/dist/index.js'), desktopRoot: app });
  assert.match(web.facts, /Web 编译产物启动/);
  assert.match(await web.guide(), /# Web \/ 源码部署/);
  assert.equal(web.desktopLogRoot, undefined);
  const dev = await diagnosticEnvironment(environment, source, { entrypoint: join(source, 'packages/api/src/index.ts'), desktopRoot: undefined });
  assert.match(dev.facts, /Web 源码启动/);
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
