import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(import.meta.url);
const cli=dirname(dirname(require.resolve('@larksuite/cli/scripts/run.js')));
const metadata=JSON.parse(await readFile(join(cli,'package.json'),'utf8'));
assert.equal(metadata.version,'1.0.85');
const platform={darwin:'darwin',linux:'linux'}[process.platform],arch={arm64:'arm64',x64:'amd64',riscv64:'riscv64'}[process.arch];
assert.ok(platform&&arch,'Meeting runner currently supports macOS/Linux');
const asset=`lark-cli-1.0.85-${platform}-${arch}.tar.gz`;
const expected=(await readFile(join(cli,'checksums.txt'),'utf8')).split('\n').find(line=>line.endsWith('  '+asset))?.split(' ')[0];
assert.match(expected??'',/^[a-f0-9]{64}$/);
const cache=join(root,'.clowder-local-directory','runner-cache');await mkdir(cache,{recursive:true});
const archive=join(cache,asset);let bytes;
try{bytes=await readFile(archive);}catch(error){if(error.code!=='ENOENT')throw error;}
const source=`https://github.com/larksuite/cli/releases/download/v1.0.85/${asset}`;
if(!bytes){
 const response=await fetch(source,{signal:AbortSignal.timeout(60_000)});assert.ok(response.ok,'Pinned Lark runner download failed');
 const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;assert.ok(size<=64*1024*1024,'Runner archive exceeds its bound');chunks.push(chunk);}
 bytes=Buffer.concat(chunks);assert.equal(createHash('sha256').update(bytes).digest('hex'),expected,'Runner archive checksum mismatch');await writeFile(archive,bytes,{flag:'wx'});
}
assert.equal(createHash('sha256').update(bytes).digest('hex'),expected,'Cached runner archive checksum mismatch');
// Extract only the known regular executable, never a supplier-selected path.
const listing=execFileSync('tar',['-tvzf',archive],{encoding:'utf8'});
assert.ok(listing.split('\n').some(line=>line.startsWith('-')&&line.endsWith(' lark-cli')),'Pinned archive must contain a regular lark-cli');
const binary=execFileSync('tar',['-xOzf',archive,'lark-cli'],{maxBuffer:64*1024*1024});
assert.ok(binary.length>0&&binary.length<=64*1024*1024);
await mkdir(join(root,'dist'),{recursive:true});await writeFile(join(root,'dist','lark-cli'),binary);await chmod(join(root,'dist','lark-cli'),0o755);
await writeFile(join(root,'dist','lark-cli-runtime.json'),JSON.stringify({version:metadata.version,platform:process.platform,arch:process.arch,source,archiveSha256:expected,binarySha256:createHash('sha256').update(binary).digest('hex')},null,2)+'\n');
console.log(JSON.stringify({asset,archiveSha256:expected,runnerBytes:binary.length}));
