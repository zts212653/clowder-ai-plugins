import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';

test('changing member and project after saving the description survives close and reopen',async()=>{
  const nodes:Array<Record<string,unknown>>=[];
  const el=(_tag?:string,attrs:Record<string,unknown>={})=>{
    const node={...attrs,dataset:{},append(){},replaceChildren(){},addEventListener(){},querySelector(){},scrollTop:0};nodes.push(node);return node;
  };
  let closePanel!:()=>Promise<void>;
  const saved:Array<{clientId:string;projectRef:string;report:unknown}>=[];
  const context=createContext({Blob,el,document:{getElementById:el,querySelector:()=>null,querySelectorAll:()=>[]},crypto:{randomUUID:()=> 'draft'},
    beforeClose:async(action:()=>Promise<void>)=>{closePanel=action;},bridge:async()=>true,copyImage:async()=>{},normalizePicture:async()=>{},reportPreview:el,feedbackHistory:el,
    setTimeout:()=>0,clearTimeout(){},console,call:async(input:{op:string;clientId:string;projectRef:string;report:unknown})=>{
      if(input.op==='save'){saved.push(structuredClone(input));return{journal:{id:'draft',state:'draft',digest:'saved',target:{id:'clowder'},...input},revision:saved.length};}
      return{targets:[],clients:[],items:[]};
    }});
  const form=await readFile(new URL('../ui/form.js',import.meta.url),'utf8');
  runInContext(form.replace(/^import[^\n]+\n/gm,'').replace(/^export /gm,''),context);
  const main=await readFile(new URL('../ui/main.js',import.meta.url),'utf8');
  await runInContext(main.replace(/^import[^\n]+\n/gm,''),context);
  const actions=runInContext('({state,saveDraft,openRecord,render})',context);
  Object.assign(actions.state,{dirty:true,clientId:'member-A',projectRef:'',targetId:'clowder',report:{title:'bug: example',body:'description already saved',attachments:[]}});
  await actions.saveDraft();actions.render();
  (nodes.findLast(node=>node.id==='analysis-member')?.onChange as (event:unknown)=>void)({target:{value:'member-B'}});
  (nodes.findLast(node=>node['aria-label']==='相关项目目录')?.onInput as (event:unknown)=>void)({target:{value:'C:/project-B'}});
  await closePanel();
  assert.equal(saved.length,2);
  const last=saved.at(-1)!;
  await actions.openRecord('draft',{journal:{id:'draft',state:'draft',target:{id:'clowder'},...last},revision:2});
  assert.equal(actions.state.clientId,'member-B');assert.equal(actions.state.projectRef,'C:/project-B');
  assert.equal(actions.state.report.body,'description already saved');
});
