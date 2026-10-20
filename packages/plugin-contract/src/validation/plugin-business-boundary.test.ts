import assert from 'node:assert/strict';
import test from 'node:test';
import * as contract from '../index.js';
import {validateManifest} from './manifest.js';

const manifest={pluginId:'dev.boundary',version:'1.0.0',contractVersion:'0.1.0',name:'Boundary',
  runtime:{transport:'builtin',entrypoint:'dist/index.js'},
  features:[{id:'main',name:'Main',resources:[],capabilities:[]}]};

test('business extensions are not grants or static Host contributions',()=>{
  assert.equal(validateManifest(manifest).valid,true);
  for(const capability of ['custody.invoke','custody.verify','deployment.read','frustration.read','frustration.link'])
    assert.equal(validateManifest({...manifest,features:[{...manifest.features[0],capabilities:[capability]}]}).valid,false,capability);
  for(const type of ['browser-service','terminal-predicate-provider'])
    assert.equal(validateManifest({...manifest,contributions:[{type,id:'private'}]}).valid,false,type);
});

test('public contract has no plugin-specific completion, deployment or feedback validators',()=>{
  for(const name of ['assertCustodyContract','assertDeploymentCatalog','assertFrustrationContract','validateBrowserServiceRequest','validateBrowserServiceDispatchResult'])
    assert.equal(Object.hasOwn(contract,name),false,name);
});
