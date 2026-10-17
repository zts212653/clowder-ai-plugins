import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, readlink, realpath, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { readRetainedSdkClosure } from './retained-sdk-fixture.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const namespace = '.clowder-local-directory';
const retained = new Set(['0.2.0-beta.12', '0.2.0-beta.12.1', '0.2.0-beta.15', '0.2.0-beta.19']);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function optionalStat(path) { try { return await lstat(path); } catch(e) { if(e.code==='ENOENT') return undefined; throw e; } }
// Every generated destination is below the selected package. Existing parents
// must be real directories, including ignored cache and node_modules components.
async function directoryChain(root, path, create = false) {
  const suffix = relative(root, resolve(path));
  assert.ok(!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep), 'source write path escapes selected package');
  let cursor = root;
  for (const part of ['', ...suffix.split(sep).filter(Boolean)]) {
    if (part) cursor = join(cursor, part);
    let info = await optionalStat(cursor);
    if (!info) {
      if (!create) return;
      await mkdir(cursor);
      info = await lstat(cursor);
    }
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'source write path must contain real directories: ' + cursor);
    assert.equal(await realpath(cursor), cursor, 'source write path has a noncanonical parent');
  }
}
async function atomic(root, path, value) {
  await directoryChain(root, dirname(path));
  const temp = path + '.' + randomUUID() + '.tmp';
  try { await writeFile(temp, value, {flag:'wx'}); await rename(temp, path); } finally { await rm(temp, {force:true}); }
}
async function link(root, target, destination) {
  await directoryChain(root, dirname(destination), true);
  const info = await optionalStat(destination);
  if(info && !info.isSymbolicLink()) throw new Error('Refusing to replace a non-link dependency: '+destination);
  const value = relative(dirname(destination), target);
  if(info && await readlink(destination) === value) return;
  const temp = destination + '.' + randomUUID() + '.tmp';
  try { await symlink(value, temp, 'dir'); await rename(temp, destination); } finally { await rm(temp, {force:true}); }
}
async function files(root) {
  const rows=[];
  async function visit(directory) {
    for(const name of (await readdir(directory)).sort()) {
      if(name==='node_modules' || name==='.source-bytes.json') continue;
      const path=join(directory,name), s=await lstat(path);
      if(s.isDirectory()) await visit(path);
      else { assert.ok(s.isFile(),'retained artifact contains a non-regular member'); rows.push({path:relative(root,path),sha256:sha(await readFile(path)),mode:s.mode&0o777}); }
    }
  }
  await visit(root);return rows;
}
async function archivePackage(root, destination, name, version, integrity) {
  const archive=join(repository,'scripts/fixtures/retained-sdk',`clowder-ai-${name}-${version}.tgz`);
  const bytes=await readFile(archive);
  assert.equal('sha512-'+createHash('sha512').update(bytes).digest('base64'),integrity);
  const marker=join(destination,'.source-bytes.json');
  await directoryChain(root, destination);
  await directoryChain(root, dirname(destination), true);
  const temporary=destination+'.'+randomUUID()+'.tmp';
  try {
    await directoryChain(root, temporary, true);
    // Only the six immutable, hash-checked archives from retained-sdk-fixture are accepted.
    // This is source preparation, not an arbitrary archive installer or registry override.
    const names=execFileSync('tar',['-tzf',archive],{encoding:'utf8'}).trim().split('\n');
    assert.ok(names.every(p=>p.startsWith('package/')&&!p.includes('\\')&&!p.split('/').includes('..')));
    execFileSync('tar',['-xzf',archive,'--strip-components=1','-C',temporary]);
    const manifest=JSON.parse(await readFile(join(temporary,'package.json'),'utf8'));
    assert.equal(manifest.name,'@clowder-ai/'+name);assert.equal(manifest.version,version);
    const members=await files(temporary);
    const expected={archiveSha256:sha(bytes),members};
    if(await optionalStat(destination)) {
      // Reconstruct the oracle from authenticated archive bytes, not the mutable cache receipt.
      assert.deepEqual(await files(destination),members,'retained physical bytes changed');
      assert.deepEqual(JSON.parse(await readFile(marker,'utf8')),expected,'retained archive receipt changed');
      return manifest;
    }
    await writeFile(join(temporary,'.source-bytes.json'),JSON.stringify(expected,null,2)+'\n');
    await rename(temporary,destination);return manifest;
  } finally { await rm(temporary,{recursive:true,force:true}); }
}

/** Prepare the selected repository source directory without changing its package declaration,
 * immutable npm shrinkwrap, business bytes, root workspace lock or shared current SDK/contract.
 * The generated package-local pnpm source lock describes the actual retained artifact graph.
 * It is for the existing owner-local Host source resolver, not npm registry publication. */
export async function prepareRetainedDirectoryGraph(directory, workspaceRoot=repository) {
  directory=await realpath(resolve(directory));workspaceRoot=await realpath(resolve(workspaceRoot));
  const packagePath=join(directory,'package.json');const packageBytes=await readFile(packagePath);
  const pkg=JSON.parse(packageBytes);const version=pkg.dependencies?.['@clowder-ai/plugin-sdk'];
  if(!retained.has(version)) return {directory:relative(workspaceRoot,directory),status:'not-retained',version};
  const verified=await readRetainedSdkClosure(version);
  if(pkg.dependencies['@clowder-ai/plugin-contract']!==undefined)
    assert.equal(pkg.dependencies['@clowder-ai/plugin-contract'],verified.contract.version,'direct contract differs from retained SDK graph');
  const rootLockBytes=await readFile(join(workspaceRoot,'pnpm-lock.yaml'));
  const rootLock=parse(rootLockBytes.toString());assert.equal(String(rootLock.lockfileVersion),'9.0');
  const sourceKey=relative(workspaceRoot,directory).split('\\').join('/');
  const sourceImporter=rootLock.importers[sourceKey];assert.ok(sourceImporter,'selected package has no workspace source importer');
  const lockPath=join(directory,'pnpm-lock.yaml');const previousLock=await optionalStat(lockPath);
  if(previousLock) {
    assert.ok(previousLock.isFile()&&!previousLock.isSymbolicLink(),'source lock must be regular');
    const previous=parse(await readFile(lockPath,'utf8'));
    assert.equal(previous['x-clowder-local-directory']?.kind,'retained-artifact-graph.v1','refusing to overwrite an independent package source lock');
  }
  const sdkDir=join(directory,namespace,'dependencies','plugin-sdk-'+verified.sdk.version);
  const contractDir=join(directory,namespace,'dependencies','plugin-contract-'+verified.contract.version);
  // Preflight all existing write parents before creating even a cache staging file.
  for (const parent of [sdkDir, contractDir, join(directory, 'node_modules/@clowder-ai'),
    join(sdkDir, 'node_modules/@clowder-ai'), join(contractDir, 'node_modules')]) {
    await directoryChain(directory, parent);
  }
  // Validate existing root aliases before preparing anything; no user-owned physical tree is removed.
  for(const [name,target] of [['plugin-sdk',sdkDir],...(pkg.dependencies['@clowder-ai/plugin-contract']?[['plugin-contract',contractDir]]:[])]) {
    const alias=join(directory,'node_modules/@clowder-ai',name), info=await optionalStat(alias);
    if(info) {
      assert.ok(info.isSymbolicLink(),'source runtime alias is not a managed link');
      const observed=await realpath(alias), current=await realpath(join(workspaceRoot,'packages',name));
      assert.ok(observed===current||observed===target,'unexpected runtime dependency alias');
    }
  }
  const sdk=await archivePackage(directory, sdkDir,'plugin-sdk',verified.sdk.version,verified.sdk.integrity);
  const contract=await archivePackage(directory, contractDir,'plugin-contract',verified.contract.version,verified.contract.integrity);
  const rootContractImporter=rootLock.importers['packages/plugin-contract'];assert.ok(rootContractImporter);
  const contractEdges={};
  for(const [name,requested] of Object.entries(contract.dependencies??{})) {
    const edge=rootContractImporter.dependencies?.[name];assert.ok(edge,'missing production contract dependency');
    const physical=await realpath(join(workspaceRoot,'packages/plugin-contract/node_modules',name));
    const observed=JSON.parse(await readFile(join(physical,'package.json'),'utf8'));
    assert.equal(observed.name,name);assert.equal(edge.version.split('(')[0],observed.version,'root dependency lock/physical version disagree');
    // The unchanged contract range, not a substituted SDK or fake registry identity, is the specifier.
    contractEdges[name]={specifier:requested,version:edge.version};
    await link(directory, physical,join(contractDir,'node_modules',name));
  }
  await link(directory, contractDir,join(sdkDir,'node_modules/@clowder-ai/plugin-contract'));
  const dependencies={...sourceImporter.dependencies};
  dependencies['@clowder-ai/plugin-sdk']={specifier:version,version:'link:'+relative(directory,sdkDir)};
  if(pkg.dependencies['@clowder-ai/plugin-contract']) dependencies['@clowder-ai/plugin-contract']={specifier:verified.contract.version,version:'link:'+relative(directory,contractDir)};
  const localLock={...rootLock,
    'x-clowder-local-directory':{kind:'retained-artifact-graph.v1',packageName:pkg.name,packageJsonSha256:sha(packageBytes),workspaceLockSha256:sha(rootLockBytes),sdk:verified.sdk,contract:verified.contract},
    importers:{'.':{...sourceImporter,dependencies},[relative(directory,sdkDir)]:{dependencies:{'@clowder-ai/plugin-contract':{specifier:sdk.dependencies['@clowder-ai/plugin-contract'],version:'link:'+relative(sdkDir,contractDir)}}},[relative(directory,contractDir)]:{dependencies:contractEdges}},
  };
  // The root and immutable consumer shrinkwrap are never rewritten; only this prepared directory's aliases/lock change.
  assert.deepEqual(await readFile(packagePath),packageBytes);assert.deepEqual(await readFile(join(workspaceRoot,'pnpm-lock.yaml')),rootLockBytes);
  await link(directory, sdkDir,join(directory,'node_modules/@clowder-ai/plugin-sdk'));
  if(pkg.dependencies['@clowder-ai/plugin-contract']) await link(directory, contractDir,join(directory,'node_modules/@clowder-ai/plugin-contract'));
  await atomic(directory, lockPath,stringify(localLock));
  return {directory:relative(workspaceRoot,directory),status:'prepared',sdk:verified.sdk.version,contract:verified.contract.version,sourceLock:lockPath,
    sourceLockSha256:sha(await readFile(lockPath)),packageJsonSha256:sha(packageBytes),registryPublication:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const results=[];
  for(const name of (await readdir(join(repository,'packages'))).sort()) {
    const directory=join(repository,'packages',name);
    if(await optionalStat(join(directory,'package.json'))) results.push(await prepareRetainedDirectoryGraph(directory));
  }
  console.log(JSON.stringify({kind:'owner-local-retained-directory-preparation',results,prepared:results.filter(r=>r.status==='prepared').length,
    limit:'source graph preparation only; existing Host inspector/distribution/runtime and installed journey still required'},null,2));
}
