import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisKey, digest } from '../src/config.js';
import { fixture } from './service-fixture.js';
import type { HydratedJournal } from '../src/types.js';
import { createHash } from 'node:crypto';
import { pngFixture } from './png-fixture.js';

type Result = { journal?: HydratedJournal; revision?: number; items?: { id: string; title: string; status: string }[] };
const report = (kind = 'bug', body = '发生了一个问题') => ({kind, title: '简短标题', body, attachments: []});

test('unfinished and uncertain feedback do not occupy a new feedback, and opening defaults to blank', async () => {
  const f = fixture();
  const call = (input: unknown) => f.service.dispatch(input, f.ctx) as Promise<Result>;
  const a = await call({op:'save',targetId:'clowder',report:report()});
  const b = await call({op:'save',targetId:'clowder',report:report('feat','希望支持批量导出')});
  assert.notEqual(a.journal!.id,b.journal!.id);
  assert.match(a.journal!.report.title,/^bug: /); assert.match(b.journal!.report.title,/^feat: /);
  const home = await call({op:'bootstrap'});
  assert.equal(home.journal,undefined); assert.equal(home.items!.length,2);
  await call({op:'approve',feedbackId:a.journal!.id,digest:a.journal!.digest,confirmed:true});
  f.fail();
  const uncertain = await call({op:'submit',feedbackId:a.journal!.id,digest:a.journal!.digest});
  assert.equal(uncertain.journal!.state,'unknown');
  const edited = await call({op:'save',feedbackId:b.journal!.id,revision:b.revision,targetId:'clowder',report:report('feat','批量导出为 Markdown')});
  assert.equal(edited.journal!.id,b.journal!.id);
  const old = await call({op:'bootstrap',feedbackId:a.journal!.id});
  assert.equal(old.journal!.state,'unknown');
  await assert.rejects(call({op:'submit',feedbackId:a.journal!.id,digest:a.journal!.digest}),/不会重复/);
  const other = await f.service.dispatch({op:'bootstrap'},{...f.ctx,userId:'another-owner'}) as Result;
  assert.deepEqual(other.items,[]);
});

test('a screenshot can be the description and type prefixes replace rather than accumulate', async () => {
  const f = fixture();
  const bytes=pngFixture();
  const image={id:'image',name:'screen.png',mime:'image/png',base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};
  const saved = await f.call({op:'save',targetId:'clowder',report:{kind:'feat',title:'bug: 导出',body:'',attachments:[image]}});
  assert.equal(saved.journal.report.title,'feat: 导出');
  assert.equal(saved.journal.report.body,''); assert.equal(saved.journal.report.attachments.length,1);
  await assert.rejects(f.call({op:'save',targetId:'clowder',revision:saved.revision,report:report('other')}),/类型/);
});

test('legacy single-slot feedback is preserved once instead of replacing the new form', async () => {
  const f = fixture();
  const source=fixture();
  const saved = await source.call({op:'save',targetId:'clowder',report:{title:'原草稿',body:'原描述',attachments:[]}});
  await f.host.storage.compareAndSet(`feedback:${digest(f.ctx.userId)}`,null,saved.journal);
  const call = () => f.service.dispatch({op:'bootstrap'},f.ctx) as Promise<Result>;
  const first = await call(), again = await call();
  assert.equal(first.journal,undefined); assert.equal(again.items!.length,1);
  const opened = await f.service.dispatch({op:'bootstrap',feedbackId:saved.journal.id},f.ctx) as Result;
  assert.equal(opened.journal!.report.body,'原描述');
});

test('an analysis and a new feedback remain independent and completion appears in history', async () => {
  const f=fixture();let count=0;
  Object.assign(f.host,{
    runtimeInfo:{get:async()=>({version:'test',platform:'win32',architecture:'x64',nodeVersion:'24',projectRoot:f.host.dataPath,logDirectory:f.host.dataPath})},
    members:{list:async()=>[],get:async()=>({catId:'member',available:true})},
    threads:{create:async()=>{const id=`thread-${++count}`;return{id,projectRef:f.host.dataPath,deepLinkUrl:`https://local.test/${id}`};},readMessages:async(id:string)=>id==='thread-1'?[{id:'reply',sender:{kind:'cat',catId:'member'},content:'# 分析报告\n\n## 摘要\n已分析',response:{status:'completed',inputMessageIds:['request-thread-1']}}]:[]},
    messaging:{subscribe:async()=>{},unsubscribe:async()=>{},send:async(input:{threadId:string})=>({messageId:`request-${input.threadId}`})},
  });
  const call=(input:unknown)=>f.service.dispatch(input,f.ctx) as Promise<Result & {hash:string;analysis:{state:string;title:string}}>;
  const a=await call({op:'save',targetId:'clowder',report:report()});
  const prepared=await call({op:'prepare-analysis',feedbackId:a.journal!.id});
  await call({op:'analyze',feedbackId:a.journal!.id,clientId:'member',hash:prepared.hash,confirmed:true});
  const b=await call({op:'save',targetId:'clowder',report:report('feat','第二条反馈')});
  const ready=await call({op:'analysis-status',feedbackId:a.journal!.id});
  assert.equal(ready.analysis.state,'ready'); assert.equal(ready.analysis.title,'bug: 分析报告');
  const home=await call({op:'bootstrap'});assert.equal(home.journal,undefined);
  assert.equal(home.items!.find(item=>item.id===a.journal!.id)!.status,'ready');
  const other=await call({op:'bootstrap',feedbackId:b.journal!.id});
  assert.equal(other.journal!.report.body,'第二条反馈'); assert.equal(other.analysis,undefined);
  await assert.rejects(f.service.dispatch({op:'bootstrap',feedbackId:a.journal!.id},{...f.ctx,userId:'outsider'}),/不存在/);
});

test('unmatched legacy analysis becomes its own history item and never overwrites the old draft', async()=>{
  const f=fixture(),source=fixture();
  const saved=await source.call({op:'save',targetId:'clowder',report:{title:'用户原草稿',body:'原正文',attachments:[]}});
  await f.host.storage.compareAndSet(`feedback:${digest(f.ctx.userId)}`,null,saved.journal);
  const legacy={id:'legacy-analysis',owner:f.ctx.userId,state:'ready',activationId:'old',threadId:'old-thread',threadUrl:'https://local.test/old',material:'E2 用户现象\n另一个问题\n不同描述',candidate:{title:'另一个报告',body:'不同分析正文'},projectRef:f.host.dataPath};
  await f.host.storage.compareAndSet(analysisKey(f.ctx.userId),null,legacy);
  const home=await f.service.dispatch({op:'bootstrap'},f.ctx) as Result;
  assert.equal(home.items!.length,2);
  const old=await f.service.dispatch({op:'bootstrap',feedbackId:saved.journal.id},f.ctx) as Result;
  assert.equal(old.journal!.report.body,'原正文');
  const again=await f.service.dispatch({op:'bootstrap'},f.ctx) as Result;assert.equal(again.items!.length,2);
  assert.deepEqual((await f.host.storage.get(analysisKey(f.ctx.userId)))!.value,legacy);
});
