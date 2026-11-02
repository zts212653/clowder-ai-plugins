import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';

test('opening a record with no analysis clears fields omitted by JSON transport', async () => {
  const node=()=>({dataset:{},append(){},replaceChildren(){},querySelector(){return undefined;},scrollTop:0});
  const context=createContext({
    document:{getElementById:node,querySelector:()=>null,querySelectorAll:()=>[]},
    el:node,reportPreview:node,feedbackForm:()=>[],feedbackHistory:node,crypto:{randomUUID:()=> 'feedback-B'},
    bridge:async()=>true,copyImage:async()=>{},normalizePicture:async()=>{},setTimeout:()=>0,clearTimeout:()=>{},console,
    call:async(input:{feedbackId?:string})=>input.feedbackId ? JSON.parse(JSON.stringify({
      journal:{id:'feedback-B',state:'draft',digest:'digest-B',target:{id:'test'},report:{title:'bug: B',body:'body B',attachments:[]}},
      revision:1,analysis:undefined,
    })) : new Promise(()=>{}),
  });
  const source=await readFile(new URL('../ui/main.js',import.meta.url),'utf8');
  runInContext(source.replace(/^import[^\n]+\n/gm,''),context);
  const actions=runInContext('({state,openRecord})',context);
  Object.assign(actions.state,{busy:false,stage:'history',dirty:false,analysis:{id:'run-A',state:'ready',title:'bug: A',body:'report A'},material:'A material',hash:'A hash',preflight:{attachments:true}});
  await actions.openRecord('feedback-B');
  assert.equal(actions.state.analysis,undefined);
  assert.equal(actions.state.material,undefined);
  assert.equal(actions.state.hash,undefined);
  assert.equal(actions.state.preflight,undefined);
  assert.equal(actions.state.report.body,'body B');
});

test('a prior poll cannot save its report into a newly prepared analysis draft', async () => {
  const node=()=>({dataset:{},append(){},replaceChildren(){},querySelector(){return undefined;},scrollTop:0});
  const saves: Array<{title:string;body:string}>=[];
  let release!: (value:unknown)=>void;
  const context=createContext({
    document:{getElementById:node,querySelector:()=>null,querySelectorAll:()=>[],createTextNode:(text:string)=>text},
    el:node,reportPreview:node,feedbackForm:()=>[],feedbackHistory:node,crypto:{randomUUID:()=> 'feedback-B'},bridge:async()=>true,copyImage:async()=>{},normalizePicture:async()=>{},setTimeout:()=>0,clearTimeout:()=>{},console,
    call:async(input: {op:string;report:{title:string;body:string}})=>{
      if(input.op==='bootstrap') return new Promise(()=>{});
      if(input.op==='analysis-status') return new Promise(resolve=>{release=resolve;});
      if(input.op==='save') {saves.push(input.report);return{journal:{id:'feedback-B',state:'draft',digest:'digest-B',target:{},report:input.report},revision:2};}
      if(input.op==='prepare-analysis') return{analysis:{id:'run-B',state:'prepared'},hash:'hash-B'};
      if(input.op==='analyze') return{analysis:{id:'run-B',state:'running'}};
      return{attachments:false};
    },
  });
  const source=await readFile(new URL('../ui/main.js',import.meta.url),'utf8');
  runInContext(source.replace(/^import[^\n]+\n/gm,''),context);
  const actions=runInContext('({state,refreshAnalysis,prepareAnalysis,analyze})',context);
  Object.assign(actions.state,{busy:false,feedbackId:'feedback-B',stage:'analyzing',analysis:{id:'run-A'},journal:{digest:'digest-A',state:'draft'},report:{title:'new problem B',body:'new body B',attachments:[]}});
  const pending=actions.refreshAnalysis();
  await actions.prepareAnalysis(); await actions.analyze();
  release({analysis:{id:'run-A',state:'ready',title:'old report A',body:'old body A'}});
  await pending;
  assert.equal(actions.state.analysis.id,'run-B');
  assert.equal(actions.state.report.title,'new problem B');
  assert.ok(!saves.some(report=>report.title==='old report A'));
});

test('an earlier save acknowledgement never marks newer input as saved', async () => {
  const status={textContent:''};
  const node=()=>({dataset:{},append(){},replaceChildren(){},querySelector(){return undefined;},scrollTop:0});
  let release!: (value:unknown)=>void;
  const context=createContext({
    document:{getElementById:node,querySelector:()=>status,querySelectorAll:()=>[]},
    el:node,reportPreview:node,feedbackForm:()=>[],feedbackHistory:node,crypto:{randomUUID:()=> 'feedback-B'},
    bridge:async()=>true,copyImage:async()=>{},normalizePicture:async()=>{},setTimeout:()=>0,clearTimeout:()=>{},console,
    call:async(input:{op:string})=>input.op==='save'?new Promise(resolve=>{release=resolve;}):new Promise(()=>{}),
  });
  const source=await readFile(new URL('../ui/main.js',import.meta.url),'utf8');
  runInContext(source.replace(/^import[^\n]+\n/gm,''),context);
  const actions=runInContext('({state,saveDraft,invalidate})',context);
  Object.assign(actions.state,{busy:false,stage:'edit',dirty:true,report:{title:'bug: B',body:'first',attachments:[]}});
  const pending=actions.saveDraft();
  assert.equal(status.textContent,'正在保存草稿…');
  actions.state.report.body='new input';actions.invalidate();
  release({journal:{state:'draft'},revision:1});await pending;
  assert.equal(actions.state.dirty,true);
  assert.equal(status.textContent,'尚未保存，关闭前请保存');
  const latest=actions.saveDraft();release({journal:{state:'draft'},revision:2});await latest;
  assert.equal(actions.state.dirty,false);
  assert.equal(status.textContent,'草稿已保存到反馈记录');
});
