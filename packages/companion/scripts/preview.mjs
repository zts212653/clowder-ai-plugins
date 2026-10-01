// Local visual inspection of the actual built renderer. No Host or media is connected.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../renderer/', import.meta.url)));
const spikeRoot = resolve(fileURLToPath(new URL('../preview/', import.meta.url)));
const skins = ['ragdoll-v1', 'yarn-ball', 'yanyan-codex', 'xianxian-codex'];
export const previewMime = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.webm': 'video/webm' };
const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>猫猫球 · 外观核对</title>
<style>body{margin:0;color:#34343a;background:#f4f1ed;font:14px system-ui}header{padding:24px 32px}h1{font-size:24px;margin:0 0 8px}p{line-height:1.6}label{margin-right:16px}select,button{font:inherit;padding:6px;border-radius:8px;border:1px solid #c9c4c0}main{margin:0 32px 32px;border:1px solid #d5d0ca;border-radius:20px;min-height:620px;display:grid;place-items:end center;background:linear-gradient(125deg,#e4e1dc,#fffaf3);padding:24px}main.dark{background:linear-gradient(125deg,#252b35,#171a22)}iframe{border:0;width:300px;height:270px;max-width:100%;transition:height .15s}small{color:#69636c}</style>
<header><h1>猫猫球 · 外观核对</h1><p>同一份正式 renderer 构建：平时只有猫身，点猫展开、右键菜单、文字按需展开。<br><small>这里仅模拟连接状态，不连接家里、不采集麦克风或屏幕；尚未替换已安装版本。</small></p>
<label>外观 <select id="skin"><option value="ragdoll-v1">旧布偶皮肤 · 修正</option><option value="yarn-ball">旧猫猫球皮肤 · 修正</option><option value="yanyan-codex">砚砚</option><option value="xianxian-codex">宪宪</option></select></label>
<label>情境 <select id="scenario"><option value="normal">正常连接</option><option value="failure">连接失败</option></select></label><button id="background">切换深色桌面</button><button id="disconnect">模拟语音断开</button><p id="note" role="status"></p></header>
<main><iframe title="实际猫猫球界面" src="/index.html?skin=ragdoll-v1"></iframe></main>
<script>const frame=document.querySelector('iframe');document.querySelector('#disconnect').onclick=()=>frame.contentWindow.postMessage('preview-disconnect',location.origin);function refresh(){frame.style.width='300px';frame.style.height='270px';frame.src='/index.html?skin='+document.querySelector('#skin').value+'&scenario='+document.querySelector('#scenario').value;}document.querySelectorAll('select').forEach(e=>e.onchange=refresh);document.querySelector('#background').onclick=()=>document.querySelector('main').classList.toggle('dark');window.addEventListener('message',e=>{if(e.source!==frame.contentWindow||e.origin!==location.origin)return;if(e.data.kind==='geometry'){frame.style.width=e.data.width+'px';frame.style.height=e.data.height+'px';}if(e.data.kind==='resize'){frame.style.width=e.data.expanded?'380px':'300px';frame.style.height=e.data.expanded?'590px':'270px';}if(e.data.kind==='note')document.querySelector('#note').textContent=e.data.text;});</script></html>`;

export function fixture(skin, failure, pending = true) {
  return `<script>
  const listeners = new Set(); const messages = [{id:'preview-history',role:'assistant',text:'这是已保存的聊天。语音进行中也可以继续查看。',name:'砚砚',companionIdentity:{
    v:1,name:'猫猫球',partner:{catId:'fable-5',displayName:'宪宪',skin:'xianxian-codex'},
    live:{catId:'codex-sol',displayName:'砚砚',transport:'gpt_live_v3',verifiedModel:null},
    deep:{catId:'fable-5',displayName:'宪宪',verifiedModel:'claude-fable-5-1'}}}];
  const callId = '11111111-1111-4111-8111-111111111111'; const realtimeSessionId = 'preview-realtime-session';
  const transcriptRows = [
    {messageId:'preview-voice-input',role:'user',text:'It is like an AI assistant that is always there, supporting you.',source:{kind:'voice',nativeThreadId:'preview-thread',realtimeSessionId,nativeItemId:'preview-input-1',nativeTurnId:'preview-turn-1'}},
    {messageId:'preview-voice-output',role:'assistant',text:'它就像一个始终在你身边支持你的 AI 助手。',source:{kind:'voice',nativeThreadId:'preview-thread',realtimeSessionId,nativeItemId:'preview-output-1',nativeTurnId:'preview-turn-2'}},
  ];
  let phase = 'idle', allowed = true;
  let companionSettings = {dutyCatProfileId:'fable-5',skin:${JSON.stringify(skin)},ballSize:72,behaviorEnabled:true,proactivePolicy:'quiet-badge',personaTone:'温暖、简短、不啰嗦',householdReadsAllowed:true};
  const identity = () => ({kind:'state',phase,displayName:'宪宪',skin:companionSettings.skin,documentsAllowed:allowed,toolsReady:phase==='talking',behaviorEnabled:companionSettings.behaviorEnabled,nativeActivity:'none',
    audio:{supportedModes:['duplex','receive_only'],activeMode:phase==='talking'?(activeMode??'duplex'):null},
    liveTransport:{kind:'gpt_live_v3',verifiedModel:null},nativeWork:{scopeId:phase==='idle'?null:'0123456789abcdef',revision:0,active:[],recent:[]},
    duty:{catId:'preview-cat',displayName:'宪宪'},carrier:{catId:'preview-cat',displayName:'宪宪'}});
  let activeMode = null; const emit = event => listeners.forEach(fn=>fn(event));
  window.addEventListener('message',event=>{if(event.source===parent&&event.origin===location.origin&&event.data==='preview-disconnect'){phase='closed';emit({kind:'media-stopped',reason:'closed'});}});
  const note = text => parent.postMessage({kind:'note',text},location.origin);
  window.clowderCompanion = {subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},async request(command){
    switch(command.kind){
      case 'state': return identity();
      case 'prepare': phase='ready';return identity();
      case 'audio.connect': activeMode=command.mode??'duplex';setTimeout(()=>{if(${failure}){emit({kind:'audio',type:'error',callId,code:'carrier_unavailable'});}else{phase='talking';emit({kind:'audio',type:'connected',callId});emit({kind:'audio',type:'transcript',callId,role:'assistant',text:'这是正在说的话，查看记录不会停止语音。',itemId:'preview-live-output',turnId:'preview-live-turn'});}},450);return {kind:'ok'};
      case 'stop': phase='idle';activeMode=null;return {kind:'ok'};
      case 'view.layout': { const width=Math.max(136,command.width+16),height=command.panel==='none'?146:command.height+158; parent.postMessage({kind:'geometry',width,height},location.origin); return {kind:'layout',width,height,pet:{x:(width-120)/2,y:height-138},panel:{x:8,y:8,width:command.width,height:command.height}}; }
      case 'view.drag':return {kind:'ok'};
      case 'view.reset':note('正式窗口会回到 Host 计算的默认桌面位置。');return {kind:'ok'};
      case 'view.hide':note('正式窗口会隐藏；可从 Clowder 的聊聊入口叫回。');return {kind:'ok'};
      case 'settings.read':return {kind:'settings',status:'available',values:companionSettings,companions:[
        {catProfileId:'fable-5',displayName:'宪宪',available:true},{catProfileId:'codex-sol',displayName:'砚砚',available:true},{catProfileId:'gemini38',displayName:'烁烁',available:false}],selectedCompanionStatus:'available'};
      case 'settings.update':{const stops=phase==='talking'&&(command.field==='dutyCatProfileId'||command.field==='householdReadsAllowed');if(stops){phase='idle';activeMode=null;}companionSettings={...companionSettings,[command.field]:command.value};allowed=companionSettings.householdReadsAllowed;return {kind:'settings-update',field:command.field,outcome:'saved',callStatus:stops?'stopped':'unchanged',applies:command.field==='personaTone'?'next_call':'now'};}
      case 'companion.disable':note('正式 Host 会结束媒体并停用当前安装实例；预览保持打开。');return {kind:'companion-lifecycle',action:'disable',outcome:'disabled'};
      case 'conversation.read':return {kind:'conversation',threadTitle:'猫猫球 · 伴随对话',messages,hasMore:false};
      case 'transcript.read':return {kind:'transcript',scope:{callId,realtimeSessionId},rows:transcriptRows,hasMore:false};
      case 'decisions.read':return ${pending}?{kind:'decisions',version:1,status:'partial',observedAt:Date.now(),
        sources:{approvals:{status:'available',coverage:'complete'},needsMe:{status:'unavailable',coverage:'unknown'}},
        items:[
          {variantRef:'preview_taste_v1',kind:'approval',summary:'保留一点呼吸感',navigation:{targets:['approval_card','origin']},approval:{resolution:'open',materializationState:'not_started',linkedNeedsMe:true}},
          {variantRef:'preview_thread_v1',kind:'approval',summary:'新线程需要完整表单确认',navigation:{targets:['approval_card']},approval:{resolution:'open',materializationState:'not_started',linkedNeedsMe:false}},
          {variantRef:'preview_repair_v1',kind:'repair',summary:'看看工作进展',navigation:{targets:['action','origin']}}
        ],page:{offset:command.offset,limit:command.limit,scope:'known_rows',hasMore:false}}:
        {kind:'decisions',status:'available',approvalCount:0,needsMeCount:0,otherNeedsMeCount:0,approvals:[],otherNeedsMe:[],
          page:{offset:command.offset,limit:command.limit,hasMoreApprovals:false,hasMoreNeedsMe:false}};
      case 'decision.open':note('正式 Host 会按当前事项重新核对并打开原处；预览不持有私有地址。');return {kind:'navigation',delivery:'requested'};
      case 'f221.inspect':note('外观预览没有受信 Host 确认窗口，也不会提交决定。');return {kind:'decision-trial',status:'unavailable'};
      case 'view.resize':parent.postMessage({kind:'resize',expanded:command.expanded},location.origin);return {kind:'ok'};
      case 'documents':allowed=command.allowed;phase='idle';return identity();
      case 'text': { const messageId='preview-text-'+command.clientMessageId; const textCallId=phase==='talking'?callId:null; messages.push({id:messageId,role:'user',text:command.text,name:'预览输入'}); if(textCallId)transcriptRows.push({messageId,role:'user',text:command.text,source:{kind:'typed',clientMessageId:command.clientMessageId,callId:textCallId}}); return {kind:'delivery',delivery:'accepted',clientMessageId:command.clientMessageId,messageId,callId:textCallId}; }
      case 'conversation.open':note('正式窗口会在这里打开原来的聊天；当前是外观预览。');return {kind:'navigation',delivery:'requested'};
      case 'screen.pick':note('预览不采集屏幕；正式窗口需要你明确选择画面。');return {kind:'error',code:'cancelled'};
      default:return {kind:'ok'};
    }
  }};
  </script>`;
}

export function createPreviewServer() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/') { res.writeHead(302, { Location: '/spike/' }); res.end(); return; }
      if (url.pathname === '/previous') { res.writeHead(200, { 'Content-Type': previewMime['.html'] }); res.end(page); return; }
      const isSpike = url.pathname.startsWith('/spike/');
      const directory = isSpike ? spikeRoot : root;
      const path = isSpike ? url.pathname.slice('/spike'.length) : url.pathname;
      const file = resolve(directory, `.${decodeURIComponent(path === '/' ? '/index.html' : path)}`);
      if (!file.startsWith(directory + sep) || !previewMime[extname(file)]) { res.writeHead(404); res.end(); return; }
      let content = await readFile(file);
      if (url.pathname === '/index.html') {
        const skin = url.searchParams.get('skin');
        if (!skins.includes(skin)) { res.writeHead(400); res.end('unknown skin'); return; }
        content = content.toString().replace('<script type="module"', `${fixture(skin, url.searchParams.get('scenario') === 'failure', url.searchParams.get('pending') !== '0')}<script type="module"`);
      }
      res.writeHead(200, { 'Content-Type': previewMime[extname(file)], 'Cache-Control': 'no-store' }); res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createPreviewServer().listen(Number(process.env.PORT ?? 3891), '127.0.0.1',
    () => console.log('Companion visual preview ready (no Host or media)'));
}
