import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';

test('Escape cancels IME composition without closing the feedback panel',async()=>{
  const listeners=new Map<string,(event:unknown)=>void>();let closes=0;let prevented=0;
  const context=createContext({window:{name:'panel',addEventListener:(type:string,handler:(event:unknown)=>void)=>listeners.set(type,handler)},
    parent:{postMessage(){}},setTimeout:()=>0,clearTimeout(){}});
  const source=await readFile(new URL('../ui/bridge.js',import.meta.url),'utf8');
  runInContext(source.replace(/^export /gm,''),context);
  context.close=()=>{closes++;};runInContext('beforeClose(close)',context);
  const keydown=listeners.get('keydown')!;
  keydown({key:'Escape',isComposing:true,preventDefault(){prevented++;}});
  assert.equal(closes,0);assert.equal(prevented,0);
  keydown({key:'Escape',isComposing:false,preventDefault(){prevented++;}});
  assert.equal(closes,1);assert.equal(prevented,1);
});
