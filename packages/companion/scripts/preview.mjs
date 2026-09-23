// Local visual inspection of the actual built renderer. No Host or media is connected.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../renderer/', import.meta.url)));
const spikeRoot = resolve(fileURLToPath(new URL('../preview/', import.meta.url)));
const skins = ['ragdoll-v1', 'yarn-ball', 'yanyan-codex', 'xianxian-codex'];
const mime = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp' };
const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>猫猫球 · 外观核对</title>
<style>body{margin:0;color:#34343a;background:#f4f1ed;font:14px system-ui}header{padding:24px 32px}h1{font-size:24px;margin:0 0 8px}p{line-height:1.6}label{margin-right:16px}select,button{font:inherit;padding:6px;border-radius:8px;border:1px solid #c9c4c0}main{margin:0 32px 32px;border:1px solid #d5d0ca;border-radius:20px;min-height:620px;display:grid;place-items:end center;background:linear-gradient(125deg,#e4e1dc,#fffaf3);padding:24px}main.dark{background:linear-gradient(125deg,#252b35,#171a22)}iframe{border:0;width:300px;height:270px;max-width:100%;transition:height .15s}small{color:#69636c}</style>
<header><h1>猫猫球 · 外观核对</h1><p>同一份正式 renderer 构建：平时只有猫身，点猫展开、右键菜单、文字按需展开。<br><small>这里仅模拟连接状态，不连接家里、不采集麦克风或屏幕；尚未替换已安装版本。</small></p>
<label>外观 <select id="skin"><option value="ragdoll-v1">旧布偶皮肤 · 修正</option><option value="yarn-ball">旧猫猫球皮肤 · 修正</option><option value="yanyan-codex">砚砚</option><option value="xianxian-codex">宪宪</option></select></label>
<label>情境 <select id="scenario"><option value="normal">正常连接</option><option value="failure">连接失败</option></select></label><button id="background">切换深色桌面</button><button id="disconnect">模拟语音断开</button><p id="note" role="status"></p></header>
<main><iframe title="实际猫猫球界面" src="/index.html?skin=ragdoll-v1"></iframe></main>
<script>const frame=document.querySelector('iframe');document.querySelector('#disconnect').onclick=()=>frame.contentWindow.postMessage('preview-disconnect',location.origin);function refresh(){frame.style.width='300px';frame.style.height='270px';frame.src='/index.html?skin='+document.querySelector('#skin').value+'&scenario='+document.querySelector('#scenario').value;}document.querySelectorAll('select').forEach(e=>e.onchange=refresh);document.querySelector('#background').onclick=()=>document.querySelector('main').classList.toggle('dark');window.addEventListener('message',e=>{if(e.source!==frame.contentWindow||e.origin!==location.origin)return;if(e.data.kind==='geometry'){frame.style.width=e.data.width+'px';frame.style.height=e.data.height+'px';}if(e.data.kind==='resize'){frame.style.width=e.data.expanded?'380px':'300px';frame.style.height=e.data.expanded?'590px':'270px';}if(e.data.kind==='note')document.querySelector('#note').textContent=e.data.text;});</script></html>`;

function fixture(skin, failure) {
  return `<script>
  const listeners = new Set(); const messages = [{id:'preview-history',role:'assistant',text:'这是已保存的聊天。语音进行中也可以继续查看。',name:'宪宪'}]; let phase = 'idle', allowed = true;
  const identity = () => ({kind:'state',phase,displayName:'猫猫',skin:${JSON.stringify(skin)},documentsAllowed:allowed,toolsReady:phase==='talking',duty:{catId:'preview-cat',displayName:'猫猫'},carrier:{catId:'preview-cat',displayName:'猫猫'}});
  const emit = event => listeners.forEach(fn=>fn(event));
  window.addEventListener('message',event=>{if(event.source===parent&&event.origin===location.origin&&event.data==='preview-disconnect'){phase='closed';emit({kind:'media-stopped',reason:'closed'});}});
  const note = text => parent.postMessage({kind:'note',text},location.origin);
  window.clowderCompanion = {subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},async request(command){
    switch(command.kind){
      case 'state': return identity();
      case 'prepare': phase='ready';return identity();
      case 'audio.connect': setTimeout(()=>{if(${failure}){emit({kind:'audio',type:'error',code:'carrier_unavailable'});}else{phase='talking';emit({kind:'audio',type:'connected'});emit({kind:'audio',type:'transcript',role:'assistant',text:'这是正在说的话，查看记录不会停止语音。'});}},450);return {kind:'ok'};
      case 'stop': phase='idle';return {kind:'ok'};
      case 'view.layout': { const width=Math.max(136,command.width+16),height=command.panel==='none'?146:command.height+158; parent.postMessage({kind:'geometry',width,height},location.origin); return {kind:'layout',width,height,pet:{x:(width-120)/2,y:height-138},panel:{x:8,y:8,width:command.width,height:command.height}}; }
      case 'view.drag':return {kind:'ok'};
      case 'view.hide':note('正式窗口会隐藏；可从 Clowder 的聊聊入口叫回。');return {kind:'ok'};
      case 'conversation.read':return {kind:'conversation',messages,hasMore:false};
      case 'view.resize':parent.postMessage({kind:'resize',expanded:command.expanded},location.origin);return {kind:'ok'};
      case 'documents':allowed=command.allowed;phase='idle';return identity();
      case 'text': messages.push({id:command.clientMessageId,role:'user',text:command.text,name:'预览输入'});return {kind:'delivery',delivery:'accepted'};
      case 'conversation.open':note('正式窗口会在这里打开原来的聊天；当前是外观预览。');return {kind:'navigation',delivery:'requested'};
      case 'screen.pick':note('预览不采集屏幕；正式窗口需要你明确选择画面。');return {kind:'error',code:'cancelled'};
      default:return {kind:'ok'};
    }
  }};
  </script>`;
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') { res.writeHead(302, { Location: '/spike/' }); res.end(); return; }
    if (url.pathname === '/previous') { res.writeHead(200, { 'Content-Type': mime['.html'] }); res.end(page); return; }
    const isSpike = url.pathname.startsWith('/spike/');
    const directory = isSpike ? spikeRoot : root;
    const path = isSpike ? url.pathname.slice('/spike'.length) : url.pathname;
    const file = resolve(directory, `.${decodeURIComponent(path === '/' ? '/index.html' : path)}`);
    if (!file.startsWith(directory + sep) || !mime[extname(file)]) { res.writeHead(404); res.end(); return; }
    let content = await readFile(file);
    if (url.pathname === '/index.html') {
      const skin = url.searchParams.get('skin');
      if (!skins.includes(skin)) { res.writeHead(400); res.end('unknown skin'); return; }
      content = content.toString().replace('<script type="module"', `${fixture(skin, url.searchParams.get('scenario') === 'failure')}<script type="module"`);
    }
    res.writeHead(200, { 'Content-Type': mime[extname(file)], 'Cache-Control': 'no-store' }); res.end(content);
  } catch { res.writeHead(404); res.end(); }
}).listen(Number(process.env.PORT ?? 3891), '127.0.0.1', () => console.log('Companion visual preview ready (no Host or media)'));
