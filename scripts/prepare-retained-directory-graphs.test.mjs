import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readlink, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse, stringify } from 'yaml';
import { prepareRetainedDirectoryGraph } from './prepare-retained-directory-graphs.mjs';
const repository=fileURLToPath(new URL('../',import.meta.url));
async function fixture() {
 const root=await mkdtemp(join(tmpdir(),'clowder-retained-source-')), directory=join(root,'packages/test-plugin');
 await mkdir(join(directory,'node_modules/@clowder-ai'),{recursive:true});
 for(const name of ['plugin-sdk','plugin-contract']) await symlink(join(repository,'packages',name),join(root,'packages',name),'dir');
 const lock=parse(await readFile(join(repository,'pnpm-lock.yaml'),'utf8'));
 lock.importers['packages/test-plugin']={dependencies:{'@clowder-ai/plugin-sdk':{specifier:'0.2.0-beta.15',version:'link:../plugin-sdk'}}};
 await writeFile(join(root,'pnpm-lock.yaml'),stringify(lock));
 await writeFile(join(directory,'package.json'),JSON.stringify({name:'test-plugin',version:'1.0.0',dependencies:{'@clowder-ai/plugin-sdk':'0.2.0-beta.15'}}));
 await symlink(join(root,'packages/plugin-sdk'),join(directory,'node_modules/@clowder-ai/plugin-sdk'),'dir');
 return {root,directory};
}
test('retained source preparation preserves declarations and root lock, and describes exact versioned physical links',async()=>{
 const {root,directory}=await fixture();
 try {
  const before=await readFile(join(root,'pnpm-lock.yaml')), pkg=await readFile(join(directory,'package.json'));
  const result=await prepareRetainedDirectoryGraph(directory,root);assert.equal(result.sdk,'0.2.0-beta.15');assert.equal(result.contract,'0.1.0-beta.30');
  const link=await readlink(join(directory,'node_modules/@clowder-ai/plugin-sdk'));
  const installed=JSON.parse(await readFile(join(directory,'node_modules/@clowder-ai/plugin-sdk/package.json')));assert.equal(installed.version,'0.2.0-beta.15');
  const lock=parse(await readFile(join(directory,'pnpm-lock.yaml'),'utf8'));assert.equal(lock.importers['.'].dependencies['@clowder-ai/plugin-sdk'].specifier,'0.2.0-beta.15');
  assert.equal(lock.importers['.'].dependencies['@clowder-ai/plugin-sdk'].version,'link:'+relative(directory,resolve(directory,'node_modules/@clowder-ai',link)));
  assert.deepEqual(await readFile(join(root,'pnpm-lock.yaml')),before);assert.deepEqual(await readFile(join(directory,'package.json')),pkg);
  assert.deepEqual(await prepareRetainedDirectoryGraph(directory,root),result,'repeated preparation is byte-stable');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('modified retained cache fails before selecting it instead of resealing changed bytes',async()=>{
 const {root,directory}=await fixture();
 try {
  await prepareRetainedDirectoryGraph(directory,root);
  await writeFile(join(directory,'node_modules/@clowder-ai/plugin-sdk/dist/index.js'),'modified');
  await assert.rejects(()=>prepareRetainedDirectoryGraph(directory,root),/physical bytes changed/);
  const marker=join(directory,'node_modules/@clowder-ai/plugin-sdk/.source-bytes.json');
  const receipt=JSON.parse(await readFile(marker,'utf8'));
  receipt.members.find(row=>row.path==='dist/index.js').sha256=createHash('sha256').update('modified').digest('hex');
  await writeFile(marker,JSON.stringify(receipt));
  await assert.rejects(()=>prepareRetainedDirectoryGraph(directory,root),/physical bytes changed/,'a mutable receipt cannot authenticate its own changed cache');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('an independent source lock and physical dependency directory are not overwritten',async()=>{
 const {root,directory}=await fixture();
 try {
  await writeFile(join(directory,'pnpm-lock.yaml'),'lockfileVersion: 9.0\nimporters: {}\n');
  await assert.rejects(()=>prepareRetainedDirectoryGraph(directory,root),/independent package source lock/);
  await rm(join(directory,'pnpm-lock.yaml'));await rm(join(directory,'node_modules/@clowder-ai/plugin-sdk'));await mkdir(join(directory,'node_modules/@clowder-ai/plugin-sdk'));
  await assert.rejects(()=>prepareRetainedDirectoryGraph(directory,root),/not a managed link/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('legacy beta.12 and direct GitHub beta.19/35 keep separate authenticated contracts',async()=>{
 for(const [sdk,contract] of [['0.2.0-beta.12','0.1.0-beta.29'],['0.2.0-beta.12.1','0.1.0-beta.29.1'],['0.2.0-beta.19','0.1.0-beta.35']]) {
  const {root,directory}=await fixture();
  try {
   const pkg={name:'test-plugin',version:'1.0.0',dependencies:{'@clowder-ai/plugin-sdk':sdk,...(sdk.endsWith('.19')?{'@clowder-ai/plugin-contract':contract}:{})}};
   await writeFile(join(directory,'package.json'),JSON.stringify(pkg));
   const lock=parse(await readFile(join(root,'pnpm-lock.yaml'),'utf8'));lock.importers['packages/test-plugin'].dependencies['@clowder-ai/plugin-sdk'].specifier=sdk;
   if(pkg.dependencies['@clowder-ai/plugin-contract']) {
    lock.importers['packages/test-plugin'].dependencies['@clowder-ai/plugin-contract']={specifier:contract,version:'link:../plugin-contract'};
    await symlink(join(root,'packages/plugin-contract'),join(directory,'node_modules/@clowder-ai/plugin-contract'),'dir');
   }
   await writeFile(join(root,'pnpm-lock.yaml'),stringify(lock));
   const result=await prepareRetainedDirectoryGraph(directory,root);assert.equal(result.sdk,sdk);assert.equal(result.contract,contract);
   const actual=JSON.parse(await readFile(join(directory,'node_modules/@clowder-ai/plugin-sdk/node_modules/@clowder-ai/plugin-contract/package.json')));assert.equal(actual.version,contract);
   assert.deepEqual(JSON.parse(await readFile(join(directory,'package.json'))),pkg);
  }finally{await rm(root,{recursive:true,force:true});}
 }
});

test('refuses generated write parent .clowder-local-directory without touching its target',async()=>{
 const {root,directory}=await fixture(),outside=await mkdtemp(join(tmpdir(),'clowder-escape-'));
 try {
  const parent=join(directory,'.clowder-local-directory');await mkdir(join(parent,'..'),{recursive:true});await rm(parent,{recursive:true,force:true});await symlink(outside,parent,'dir');
  const lockBefore=await readFile(join(root,'pnpm-lock.yaml'));
  await assert.rejects(()=>prepareRetainedDirectoryGraph(directory,root),/source write path/);
  assert.deepEqual(await readdir(outside),[]);assert.deepEqual(await readFile(join(root,'pnpm-lock.yaml')),lockBefore);
  assert.equal(await readlink(parent),outside,'reject without replacing or deleting the link');
 }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});

test('refuses generated write parent .clowder-local-directory/dependencies without touching its target',async()=>{
 const {root,directory}=await fixture(),outside=await mkdtemp(join(tmpdir(),'clowder-escape-'));
 try {
  const parent=join(directory,'.clowder-local-directory/dependencies');await mkdir(join(parent,'..'),{recursive:true});await rm(parent,{recursive:true,force:true});await symlink(outside,parent,'dir');
  const lockBefore=await readFile(join(root,'pnpm-lock.yaml'));
  await assert.rejects(()=>prepareRetainedDirectoryGraph(directory,root),/source write path/);
  assert.deepEqual(await readdir(outside),[]);assert.deepEqual(await readFile(join(root,'pnpm-lock.yaml')),lockBefore);
  assert.equal(await readlink(parent),outside,'reject without replacing or deleting the link');
 }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});

test('refuses generated write parent node_modules without touching its target',async()=>{
 const {root,directory}=await fixture(),outside=await mkdtemp(join(tmpdir(),'clowder-escape-'));
 try {
  const parent=join(directory,'node_modules');await mkdir(join(parent,'..'),{recursive:true});await rm(parent,{recursive:true,force:true});await symlink(outside,parent,'dir');
  const lockBefore=await readFile(join(root,'pnpm-lock.yaml'));
  await assert.rejects(()=>prepareRetainedDirectoryGraph(directory,root),/source write path/);
  assert.deepEqual(await readdir(outside),[]);assert.deepEqual(await readFile(join(root,'pnpm-lock.yaml')),lockBefore);
  assert.equal(await readlink(parent),outside,'reject without replacing or deleting the link');
 }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});

test('refuses generated write parent node_modules/@clowder-ai without touching its target',async()=>{
 const {root,directory}=await fixture(),outside=await mkdtemp(join(tmpdir(),'clowder-escape-'));
 try {
  const parent=join(directory,'node_modules/@clowder-ai');await mkdir(join(parent,'..'),{recursive:true});await rm(parent,{recursive:true,force:true});await symlink(outside,parent,'dir');
  const lockBefore=await readFile(join(root,'pnpm-lock.yaml'));
  await assert.rejects(()=>prepareRetainedDirectoryGraph(directory,root),/source write path/);
  assert.deepEqual(await readdir(outside),[]);assert.deepEqual(await readFile(join(root,'pnpm-lock.yaml')),lockBefore);
  assert.equal(await readlink(parent),outside,'reject without replacing or deleting the link');
 }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});

test('refuses symlink archive destination plugin-sdk-0.2.0-beta.15 before writing',async()=>{
 const {root,directory}=await fixture(),outside=await mkdtemp(join(tmpdir(),'clowder-archive-escape-'));
 try {
  const target=join(directory,'.clowder-local-directory/dependencies/plugin-sdk-0.2.0-beta.15');await mkdir(join(target,'..'),{recursive:true});await symlink(outside,target,'dir');
  await assert.rejects(()=>prepareRetainedDirectoryGraph(directory,root),/source write path/);assert.deepEqual(await readdir(outside),[]);assert.equal(await readlink(target),outside);
 }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});

test('refuses symlink archive destination plugin-contract-0.1.0-beta.30 before writing',async()=>{
 const {root,directory}=await fixture(),outside=await mkdtemp(join(tmpdir(),'clowder-archive-escape-'));
 try {
  const target=join(directory,'.clowder-local-directory/dependencies/plugin-contract-0.1.0-beta.30');await mkdir(join(target,'..'),{recursive:true});await symlink(outside,target,'dir');
  await assert.rejects(()=>prepareRetainedDirectoryGraph(directory,root),/source write path/);assert.deepEqual(await readdir(outside),[]);assert.equal(await readlink(target),outside);
 }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});

test('refuses existing cache runtime parent plugin-sdk-0.2.0-beta.15/node_modules/@clowder-ai before writing',async()=>{
 const {root,directory}=await fixture(),outside=await mkdtemp(join(tmpdir(),'clowder-runtime-escape-'));
 try {
  await prepareRetainedDirectoryGraph(directory,root);const target=join(directory,'.clowder-local-directory/dependencies/plugin-sdk-0.2.0-beta.15/node_modules/@clowder-ai');
  await rm(target,{recursive:true,force:true});await symlink(outside,target,'dir');
  const lockBefore=await readFile(join(directory,'pnpm-lock.yaml'));
  await assert.rejects(()=>prepareRetainedDirectoryGraph(directory,root),/source write path/);assert.deepEqual(await readdir(outside),[]);assert.equal(await readlink(target),outside);
  assert.deepEqual(await readFile(join(directory,'pnpm-lock.yaml')),lockBefore);
 }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});

test('refuses existing cache runtime parent plugin-contract-0.1.0-beta.30/node_modules before writing',async()=>{
 const {root,directory}=await fixture(),outside=await mkdtemp(join(tmpdir(),'clowder-runtime-escape-'));
 try {
  await prepareRetainedDirectoryGraph(directory,root);const target=join(directory,'.clowder-local-directory/dependencies/plugin-contract-0.1.0-beta.30/node_modules');
  await rm(target,{recursive:true,force:true});await symlink(outside,target,'dir');
  const lockBefore=await readFile(join(directory,'pnpm-lock.yaml'));
  await assert.rejects(()=>prepareRetainedDirectoryGraph(directory,root),/source write path/);assert.deepEqual(await readdir(outside),[]);assert.equal(await readlink(target),outside);
  assert.deepEqual(await readFile(join(directory,'pnpm-lock.yaml')),lockBefore);
 }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});

test('refuses non-directory archive destination without replacing its bytes',async()=>{
 const {root,directory}=await fixture();
 try {
  const target=join(directory,'.clowder-local-directory/dependencies/plugin-sdk-0.2.0-beta.15');await mkdir(join(target,'..'),{recursive:true});await writeFile(target,'independent file');
  await assert.rejects(()=>prepareRetainedDirectoryGraph(directory,root),/source write path/);assert.equal(await readFile(target,'utf8'),'independent file');
 }finally{await rm(root,{recursive:true,force:true});}
});
