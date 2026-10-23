import assert from 'node:assert/strict';
import test from 'node:test';
import * as contract from '../index.js';
import {validateManifest} from './manifest.js';

const manifest={pluginId:'dev.boundary',version:'1.0.0',contractVersion:'0.1.0',name:'Boundary',
  runtime:{transport:'builtin',entrypoint:'dist/index.js'},
  features:[{id:'main',name:'Main',resources:[],}]};

test('public contract has no plugin-specific completion, deployment or feedback validators',()=>{
  for(const name of ['assertCustodyContract','assertDeploymentCatalog','assertFrustrationContract','validateBrowserServiceRequest','validateBrowserServiceDispatchResult'])
    assert.equal(Object.hasOwn(contract,name),false,name);
});
