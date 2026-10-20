import assert from 'node:assert/strict';
import test from 'node:test';
import {validateManifest} from '../index.js';

const base = {
  pluginId:'test.addressed',version:'0.1.0',contractVersion:'0.1.0',name:'Addressed target',
  features:[{id:'chat',name:'Chat',resources:[],capabilities:['messaging.send']}],
  runtime:{transport:'builtin',entrypoint:'dist/plugin.js'},
};
test('addressed delivery is an explicit optional closed action pointer',()=>{
  assert.equal(validateManifest(base).valid,true);
  assert.equal(validateManifest({...base,addressedDelivery:{method:'deliverMessage'}}).valid,true);
  for(const addressedDelivery of [{},{method:''},{method:'deliverMessage',alias:'dot'},true,null]) {
    assert.equal(validateManifest({...base,addressedDelivery}).valid,false,JSON.stringify(addressedDelivery));
  }
});

test('non-UI migration is a separate closed action declaration',()=>{
  assert.equal(validateManifest({...base,migration:{method:'dot.import'}}).valid,true);
  for(const migration of [{},{method:''},{method:'dot.import',autoEnable:true},null])
    assert.equal(validateManifest({...base,migration}).valid,false);
});

test('webhook body budgets opt in within a fixed cap without changing admission',()=>{
  const webhook={type:'webhook',id:'mcp',path:'mcp',methods:['POST'],action:{method:'dot.rpc'}};
  const manifest={...base,contributions:[webhook],features:[{...base.features[0],contributions:[{type:'webhook',id:'mcp'}]}]};
  assert.equal(validateManifest(manifest).valid,true);
  for(const requestBodyLimitBytes of [1,1048576,15*1024*1024])
    assert.equal(validateManifest({...manifest,contributions:[{...webhook,requestBodyLimitBytes}]}).valid,true);
  for(const requestBodyLimitBytes of [0,-1,1.5,15*1024*1024+1,Number.MAX_SAFE_INTEGER,Infinity,'15728640'])
    assert.equal(validateManifest({...manifest,contributions:[{...webhook,requestBodyLimitBytes}]}).valid,false,String(requestBodyLimitBytes));
  // Body budget cannot opt an owner-authenticated webhook into anonymous delivery.
  const valid=validateManifest({...manifest,contributions:[{...webhook,requestBodyLimitBytes:15728640}]});
  if(!valid.valid)throw new Error('expected a valid owner webhook');
  assert.equal(Object.hasOwn(valid.manifest.contributions![0]!,'verificationSecretRef'),false);
});

test('public webhook budgets are generated from the schema',async()=>{
  const contract=await import('../index.js');
  assert.equal(contract.PLUGIN_WEBHOOK_DEFAULT_REQUEST_BODY_LIMIT_BYTES,1048576);
  assert.equal(contract.PLUGIN_WEBHOOK_MAX_REQUEST_BODY_LIMIT_BYTES,15728640);
});
