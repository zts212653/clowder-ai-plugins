import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';

test('opening a record with no analysis clears fields omitted by JSON transport', async () => {
  const node=()=>({dataset:{},append(){},replaceChildren(){},addEventListener(){},querySelector(){return undefined;},scrollTop:0});
  const context=createContext({Blob,atob,
    document:{getElementById:node,querySelector:()=>null,querySelectorAll:()=>[]},
    el:node,reportPreview:node,feedbackForm:()=>[],feedbackHistory:node,crypto:{randomUUID:()=> 'feedback-B'},
    bridge:async()=>true,beforeClose:async()=>{},copyImage:async()=>{},normalizePicture:async()=>{},setTimeout:()=>0,clearTimeout:()=>{},console,
    call:async(input:{feedbackId?:string})=>input.feedbackId ? JSON.parse(JSON.stringify({
      journal:{id:'feedback-B',state:'draft',digest:'digest-B',target:{id:'test'},clientId:'member-B',projectRef:'C:/project-B',report:{title:'bug: B',body:'body B',attachments:[]}},
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
  assert.equal(actions.state.clientId,'member-B');
  assert.equal(actions.state.projectRef,'C:/project-B');
});

test('a prior poll cannot save its report into a newly prepared analysis draft', async () => {
  const node=()=>({dataset:{},append(){},replaceChildren(){},addEventListener(){},querySelector(){return undefined;},scrollTop:0});
  const saves: Array<{title:string;body:string}>=[];
  let release!: (value:unknown)=>void;
  const context=createContext({Blob,atob,
    document:{getElementById:node,querySelector:()=>null,querySelectorAll:()=>[],createTextNode:(text:string)=>text},
    el:node,reportPreview:node,feedbackForm:()=>[],feedbackHistory:node,crypto:{randomUUID:()=> 'feedback-B'},bridge:async()=>true,beforeClose:async()=>{},copyImage:async()=>{},normalizePicture:async()=>{},setTimeout:()=>0,clearTimeout:()=>{},console,
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
  const node=()=>({dataset:{},append(){},replaceChildren(){},addEventListener(){},querySelector(){return undefined;},scrollTop:0});
  let release!: (value:unknown)=>void;
  const context=createContext({Blob,atob,
    document:{getElementById:node,querySelector:()=>status,querySelectorAll:()=>[]},
    el:node,reportPreview:node,feedbackForm:()=>[],feedbackHistory:node,crypto:{randomUUID:()=> 'feedback-B'},
    bridge:async()=>true,beforeClose:async()=>{},copyImage:async()=>{},normalizePicture:async()=>{},setTimeout:()=>0,clearTimeout:()=>{},console,
    call:async(input:{op:string})=>input.op==='save'?new Promise(resolve=>{release=resolve;}):new Promise(()=>{}),
  });
  const source=await readFile(new URL('../ui/main.js',import.meta.url),'utf8');
  runInContext(source.replace(/^import[^\n]+\n/gm,''),context);
  const actions=runInContext('({state,saveDraft,invalidate})',context);
  Object.assign(actions.state,{busy:false,stage:'edit',dirty:true,report:{title:'bug: B',body:'first',attachments:[]}});
  const pending=actions.saveDraft();
  assert.equal(status.textContent,'正在保存草稿…');
  actions.state.report.body='new input';actions.invalidate();
  await Promise.resolve();release({journal:{state:'draft'},revision:1});await pending;
  assert.equal(actions.state.dirty,true);
  assert.equal(status.textContent,'草稿有更新，将自动保存');
  const latest=actions.saveDraft();await Promise.resolve();release({journal:{state:'draft'},revision:2});await latest;
  assert.equal(actions.state.dirty,false);
  assert.equal(status.textContent,'草稿已保存到反馈记录');
});

test('closing waits for the automatic save of a completed analysis', async () => {
  const messages: string[]=[];
  let closePanel!: () => Promise<void>;
  let release!: (value:unknown)=>void;
  let started!: ()=>void;
  const saving=new Promise<void>(resolve=>{started=resolve;});
  const node=()=>({dataset:{},append(){},replaceChildren(){},addEventListener(){},querySelector(){return undefined;},scrollTop:0});
  const context=createContext({Blob,atob,
    document:{getElementById:node,querySelector:()=>null,querySelectorAll:()=>[]},el:node,reportPreview:node,feedbackForm:()=>[],feedbackHistory:node,
    crypto:{randomUUID:()=> 'draft'},setTimeout:()=>0,clearTimeout(){},console,copyImage:async()=>{},normalizePicture:async()=>{},
    bridge:async(type:string)=>{messages.push(type);},beforeClose:async(action:()=>Promise<void>)=>{closePanel=action;},
    call:async(input:{op:string;report:unknown})=>{
      if(input.op==='bootstrap')return{targets:[],clients:[],items:[]};
      if(input.op==='analysis-status')return{analysis:{id:'run',state:'ready',title:'bug: 分析报告',body:'完成的正文'}};
      if(input.op==='save') {
        const saved={journal:{id:'draft',state:'draft',digest:'saved',target:{},report:input.report},revision:2};
        if(!release)return new Promise(resolve=>{release=resolve;started();});
        return saved;
      }
      return{attachments:false};
    },
  });
  const source=await readFile(new URL('../ui/main.js',import.meta.url),'utf8');
  await runInContext(source.replace(/^import[^\n]+\n/gm,''),context);
  const actions=runInContext('({state,refreshAnalysis})',context);
  Object.assign(actions.state,{stage:'analyzing',dirty:false,analysis:{id:'run'},journal:{id:'draft',state:'draft',digest:'source',target:{}}});
  const poll=actions.refreshAnalysis();
  await saving;
  const closing=closePanel();
  await Promise.resolve();
  assert.deepEqual(messages,[]);
  release({journal:{id:'draft',state:'draft',digest:'saved',target:{}},revision:1});
  await poll;await closing;
  assert.ok(messages.includes('close'),'the queued close must finish after analysis saving');
});

test('a stale window can preserve its edits as a new draft and then close', async () => {
  let closePanel!:()=>Promise<void>;
  const messages:string[]=[];
  const node=()=>({dataset:{},append(){},replaceChildren(){},addEventListener(){},querySelector(){},scrollTop:0});
  const context=createContext({Blob,atob,document:{getElementById:node,querySelector:()=>null,querySelectorAll:()=>[]},el:node,reportPreview:node,feedbackForm:()=>[],feedbackHistory:node,
    crypto:{randomUUID:()=> 'copy'},setTimeout:()=>0,clearTimeout(){},console,normalizePicture:async()=>{},copyImage:async()=>{},
    beforeClose:async(action:()=>Promise<void>)=>{closePanel=action;},bridge:async(type:string)=>{messages.push(type);},
    call:async(input:{op:string;feedbackId?:string;report?:unknown})=>{
      if(input.op==='bootstrap')return{targets:[],clients:[],items:[]};
      if(input.feedbackId==='old')throw Object.assign(new Error('草稿版本已变化，请重新打开'),{code:'revision_conflict'});
      return{journal:{id:'copy',state:'draft',target:{id:'clowder'},report:input.report},revision:3};
    }});
  const source=await readFile(new URL('../ui/main.js',import.meta.url),'utf8');
  await runInContext(source.replace(/^import[^\n]+\n/gm,''),context);
  const actions=runInContext('({state,saveDraft})',context);
  Object.assign(actions.state,{feedbackId:'old',revision:1,dirty:true,journal:{id:'old',state:'draft',target:{id:'clowder'}},report:{title:'my edit',body:'unsaved contents',attachments:[]}});
  await closePanel();
  assert.deepEqual(messages,['close.cancel']);
  await actions.saveDraft(true);
  assert.equal(actions.state.feedbackId,'copy');
  assert.equal(actions.state.report.body,'unsaved contents');
  assert.equal(actions.state.saveError,'');
  await closePanel();
  assert.deepEqual(messages,['close.cancel','close']);
});

test('adding pictures refuses an oversized HTTP envelope before changing the retained draft', async () => {
  const node=()=>({dataset:{},append(){},replaceChildren(){},querySelector(){return undefined;},addEventListener(){},scrollTop:0});
  const context=createContext({Blob,atob,
    document:{getElementById:node,querySelector:()=>null,querySelectorAll:()=>[]},
    el:node,reportPreview:node,feedbackForm:()=>[],feedbackHistory:node,crypto:{randomUUID:()=> 'feedback-wire-budget'},
    bridge:async()=>true,beforeClose:async()=>{},copyImage:async()=>{},setTimeout:()=>0,clearTimeout:()=>{},console,
    normalizePicture:async()=>({mime:'image/png',base64:'a'.repeat(4_000_000),original:{base64:'b'.repeat(4_000_000)}}),
    call:async()=>new Promise(()=>{}),
  });
  const source=await readFile(new URL('../ui/main.js',import.meta.url),'utf8');
  runInContext(source.replace(/^import[^\n]+\n/gm,''),context);
  const actions=runInContext('({state,addFiles})',context);
  const file={size:3_000_000,type:'image/png'};
  await actions.addFiles([file]);
  assert.equal(actions.state.report.attachments.length,1);
  await assert.rejects(actions.addFiles([file]),/图片合计过大/);
  assert.equal(actions.state.report.attachments.length,1);
  const medium=Buffer.alloc(1_500_000).toString('base64');
  context.normalizePicture=async()=>({mime:'image/png',base64:medium,original:{base64:medium}});
  actions.state.report.attachments=[];
  await assert.rejects(actions.addFiles([file,file,file,file]),/图片合计过大/);
  assert.equal(actions.state.report.attachments.length,0,'4×1.5 MB rejects the whole batch before changing the draft');
  const large=Buffer.alloc(4_000_000).toString('base64');
  context.normalizePicture=async()=>({mime:'image/png',base64:large,original:{base64:large}});
  actions.state.report.attachments=[];
  await assert.rejects(actions.addFiles([file,file,file]),/图片合计过大/);
  assert.equal(actions.state.report.attachments.length,0,'3×4 MB is rejected before it can exceed the Host bridge');
});

test('legacy analysis settings are adopted, while a different saved context cannot apply an old report',async()=>{
  const node=()=>({dataset:{},append(){},replaceChildren(){},addEventListener(){},querySelector(){},scrollTop:0});
  const writes:Array<{clientId:string;projectRef:string}>=[];
  const context=createContext({Blob,atob,document:{getElementById:node,querySelector:()=>null,querySelectorAll:()=>[]},el:node,feedbackForm:()=>[],feedbackHistory:node,reportPreview:node,
    crypto:{randomUUID:()=> 'draft'},beforeClose:async()=>{},bridge:async()=>true,setTimeout:()=>0,clearTimeout(){},console,
    call:async(input:{op:string;clientId:string;projectRef:string;report:unknown})=>{
      if(input.op==='bootstrap')return new Promise(()=>{});
      if(input.op==='save'){writes.push(input);return{journal:{id:'draft',state:'draft',target:{id:'clowder'},report:input.report},revision:2};}
      return{attachments:false};
    }});
  const source=await readFile(new URL('../ui/main.js',import.meta.url),'utf8');runInContext(source.replace(/^import[^\n]+\n/gm,''),context);
  const actions=runInContext('({state,openRecord})',context);
  Object.assign(actions.state,{busy:false,stage:'history'});
  const journal={id:'draft',state:'draft',digest:'source',target:{id:'clowder'},report:{title:'original',body:'original body',attachments:[]}};
  const analysis={state:'ready',journalDigest:'source',clientId:'old-member',projectRef:'C:/old-project',title:'analyzed',body:'analyzed body'};
  await actions.openRecord('draft',{journal,analysis,revision:1});
  assert.equal(writes[0]?.clientId,'old-member');assert.equal(writes[0]?.projectRef,'C:/old-project');
  await actions.openRecord('draft',{journal:{...journal,clientId:'new-member',projectRef:'C:/new-project'},analysis,revision:3});
  assert.equal(actions.state.report.body,'original body');assert.equal(writes.length,1);
});

test('a rejected multi-select preserves the saved draft when saving and reopening it', async () => {
  const status={textContent:'草稿已保存到反馈记录'};
  const node=()=>({dataset:{},append(){},replaceChildren(){},querySelector(){return undefined;},addEventListener(){},scrollTop:0});
  const report={kind:'bug',title:'bug: saved',body:'retained description',attachments:[{mime:'image/png',base64:'c2F2ZWQ='}]};
  let journal={id:'saved-draft',state:'draft',digest:'saved-digest',target:{id:'test'},report:structuredClone(report)};
  let saveRequests=0;
  const context=createContext({atob,
    document:{getElementById:node,querySelector:()=>status,querySelectorAll:()=>[]},
    el:node,reportPreview:node,feedbackForm:()=>[],feedbackHistory:node,crypto:{randomUUID:()=> 'saved-draft'},
    bridge:async()=>true,beforeClose:async()=>{},copyImage:async()=>{},Blob,setTimeout:()=>0,clearTimeout:()=>{},console,
    normalizePicture:async()=>({mime:'image/png',base64:'a'.repeat(4_000_000),original:{base64:'b'.repeat(4_000_000)}}),
    call:async(input:{op:string;feedbackId?:string;report?:typeof report})=>{
      if(input.op==='save') {
        assert.ok(input.report);
        saveRequests++;
        journal={...journal,report:structuredClone(input.report)};
        return{journal:structuredClone(journal),revision:2};
      }
      if(input.op==='bootstrap'&&input.feedbackId)return{journal:structuredClone(journal),revision:1};
      return new Promise(()=>{});
    },
  });
  const source=await readFile(new URL('../ui/main.js',import.meta.url),'utf8');
  runInContext(source.replace(/^import[^\n]+\n/gm,''),context);
  const actions=runInContext('({state,addFiles,flushDraft,openRecord})',context);
  Object.assign(actions.state,{busy:false,stage:'edit',dirty:false,journal:structuredClone(journal),revision:1,report:structuredClone(report)});
  const file={size:3_000_000,type:'image/png'};

  await assert.rejects(actions.addFiles([file,file]),/图片合计过大/);
  assert.equal(actions.state.report.attachments.length,report.attachments.length);
  assert.equal(JSON.stringify(actions.state.report),JSON.stringify(report));
  assert.equal(actions.state.dirty,false);
  assert.equal(status.textContent,'草稿已保存到反馈记录');
  await actions.flushDraft();
  assert.equal(saveRequests,0);

  actions.state.report={kind:'bug',title:'',body:'',attachments:[]};
  await actions.openRecord('saved-draft');
  assert.equal(JSON.stringify(actions.state.report),JSON.stringify(report));
  assert.equal(actions.state.dirty,false);
});
