import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { previewFixture } from '../test/preview-fixture.mjs';
const fixture = await previewFixture();
const wrapper = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>微信代聊 · 隔离验收</title><style>body{margin:0;font:14px sans-serif}aside{padding:10px;background:#fff3d4;color:#573e10}iframe{width:100%;height:calc(100vh - 48px);border:0}</style><aside>隔离验收：模拟微信与模型，不连接真实账号，不会对外发送。</aside><iframe id="panel" name="isolated-preview" src="/panel"></iframe><script>const frame=document.getElementById('panel');window.addEventListener('message',async event=>{const data=event.data;if(event.source!==frame.contentWindow||data?.channel!=='clowder-plugin-ui/v1'||data.nonce!=='isolated-preview'||data.type!=='http')return;try{const response=await fetch('/fixture-control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data.request.body)});const body=await response.json();frame.contentWindow.postMessage({channel:data.channel,nonce:data.nonce,requestId:data.requestId,result:{status:response.status,body}},'*')}catch{frame.contentWindow.postMessage({channel:data.channel,nonce:data.nonce,requestId:data.requestId,error:'隔离验收请求失败'},'*')}})</script></html>`;
const server = createServer(async (request, response) => {
  if (request.method === 'GET' && ['/', '/panel'].includes(request.url)) { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(request.url === '/' ? wrapper : await readFile(new URL('../dist/panel.html', import.meta.url), 'utf8')); return; }
  if (request.method !== 'POST' || request.url !== '/fixture-control') { response.writeHead(404).end(); return; }
  let raw = ''; for await (const chunk of request) { raw += chunk; if (raw.length > 65536) { response.writeHead(413).end(); return; } }
  response.setHeader('content-type', 'application/json');
  try { response.end(JSON.stringify(await fixture.runtime.dispatch(JSON.parse(raw), fixture.owner))); }
  catch (error) { response.writeHead(409).end(JSON.stringify({ error: error.message })); }
});
const port = Number(process.env.WECHAT_PREVIEW_PORT ?? 5188);
server.listen(port, '127.0.0.1', () => process.stdout.write(`Isolated preview: http://127.0.0.1:${port}\n`));
for (const event of ['SIGTERM', 'SIGINT']) process.once(event, async () => { await fixture.runtime.stop(); server.close(); });
