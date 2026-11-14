import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('final packed artifact starts and serves its real panel in an empty offline consumer without hoisted dependencies or native startup', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wechat-packed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const environment = { ...process.env, NPM_CONFIG_CACHE: join(root, 'cache'), NPM_CONFIG_OFFLINE: 'true' };
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', root], { cwd, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const artifact = join(root, packed[0].filename);
  assert.ok(packed[0].files.some(file => file.path === 'dist/panel.html'));
  assert.ok(!packed[0].files.some(file => file.path.startsWith('test/') || file.path.startsWith('node_modules/')));
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', artifact], { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  const probe = `import assert from 'node:assert/strict';
globalThis.fetch=()=>{throw Error('unexpected network access')};
const {default:plugin}=await import('@clowder-ai/wechat-delegation');
const data=new Map();
const host={pluginInstanceId:'packed',dataPath:'${root.replaceAll('\\', '\\\\')}/data',storage:{get:async key=>data.get(key),compareAndSet:async(key,expected,value)=>{const old=data.get(key);if((old?.revision??null)!==expected)return{applied:false};data.set(key,{revision:(old?.revision??0)+1,value:structuredClone(value)});return{applied:true}}}};
const loaded=await plugin.create().start(host);
const owner={kind:'owner-http-request',operation:'read',pluginInstanceId:'packed',userId:'owner',requestIdentity:{method:'GET',path:'panel'},signal:new AbortController().signal,assertCurrent:async()=>{}};
await assert.rejects(loaded.actions['wechat.panel']({request:{method:'GET',path:'panel'}}));
const page=await loaded.actions['wechat.panel']({request:{method:'GET',path:'panel',principal:{id:'owner'}}},undefined,owner);
assert.equal(page.status,200);assert.match(page.body,/暂停全部代聊/);assert.match(page.body,/clowder-plugin-ui/);
await loaded.stop();process.stdout.write('packed-consumer-ok');`;
  await writeFile(join(root, 'probe.mjs'), probe);
  assert.equal(execFileSync(process.execPath, ['probe.mjs'], { cwd: root, env: environment, encoding: 'utf8' }), 'packed-consumer-ok');
  const installed = JSON.parse(await readFile(join(root, 'node_modules/@clowder-ai/wechat-delegation/package.json'), 'utf8'));
  assert.equal(installed.dependencies, undefined);
  const mcp = execFileSync(process.execPath, [join(root, 'node_modules/@clowder-ai/wechat-delegation/dist/empty-mcp.mjs')], {
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_file' } }) + '\n',
    encoding: 'utf8', env: environment,
  }).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(mcp[0].result.tools, []);
  assert.equal(mcp[1].error.code, -32601);
});
