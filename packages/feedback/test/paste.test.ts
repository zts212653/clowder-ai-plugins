import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';

test('pasting an image uses the file attachment path, while text paste stays native', async () => {
  const listeners = new Map<string, (event: unknown) => Promise<void>>();
  const node = () => ({dataset:{},append(){},replaceChildren(){},querySelector(){},addEventListener:(type:string,handler:(event:unknown)=>Promise<void>)=>listeners.set(type,handler)});
  const normalized: unknown[]=[];
  const context = createContext({document:{getElementById:node,querySelector:()=>null,querySelectorAll:()=>[]},el:node,reportPreview:node,feedbackForm:()=>[],feedbackHistory:node,
    Blob,atob,crypto:{randomUUID:()=> 'draft'},bridge:async()=>true,beforeClose:async()=>{},copyImage:async()=>{},normalizePicture:async(file:unknown)=>{normalized.push(file);return{mime:'image/png',name:'paste.png',base64:'cG5n'};},
    setTimeout:()=>0,clearTimeout(){},console,call:async()=>({targets:[],clients:[],items:[]})});
  const source = await readFile(new URL('../ui/main.js',import.meta.url),'utf8');
  await runInContext(source.replace(/^import[^\n]+\n/gm,''),context);
  const { state } = runInContext('({state})',context);
  const paste = listeners.get('paste');
  assert.ok(paste,'the feedback editor must listen for clipboard paste');
  let prevented = false;
  const file={type:'image/png',size:12};
  await paste({clipboardData:{items:[{type:'image/png',getAsFile:()=>file}]},preventDefault(){prevented=true;}});
  assert.equal(prevented,true);
  assert.deepEqual(normalized,[file]);
  assert.equal(state.report.attachments.length,1);
  prevented=false;
  await paste({clipboardData:{items:[{type:'text/plain'}]},preventDefault(){prevented=true;}});
  assert.equal(prevented,false);
  assert.equal(state.report.attachments.length,1);
});
