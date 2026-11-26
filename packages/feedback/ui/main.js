import { bridge, call, copyImage, el, normalizePicture, beforeClose } from './bridge.js';
import { reportPreview, reportReader, bindReportReader } from './report.js';
import { feedbackForm, analysisSettings } from './form.js';
import { feedbackHistory } from './history.js';

const app = document.getElementById('app');
const state = { stage: 'edit', feedbackId:crypto.randomUUID(), items:[], report: { kind:'bug', title: '', body: '', attachments: [] }, targets: [], targetId: '', clients: [], clientId: '',
  consent: false, busy: false, error: '', saveError:'', saveErrorCode:'', selectionSaved:true, dirty: false, automatic: false, projectRef: '', analysis: undefined, contextChanged:false, preview: true,
  reviewView:'report', reviewImage:0, reviewScroll:0, routeDirty:false, routeProblem:undefined, feedbackNotice:'' };
let analysisTimer;
let analysisEpoch = 0;
let historyTimer, draftTimer;
let pendingDraft=Promise.resolve();
let pendingAction=Promise.resolve();
let editVersion=0;
let unbindReader;
async function copyLink(url) {
  await bridge('clipboard.text',url);
  state.feedbackNotice='链接已复制，可在浏览器打开。';
}
const checkRequestBudget = request=>{
  if(new Blob([JSON.stringify({input:request})]).size>15*1024*1024)throw new Error('图片合计过大，请减少图片或裁剪后再添加');
};
const recordCall = (input,feedbackId=state.feedbackId)=>{
  const sourceId=state.feedbackId;
  return Promise.resolve().then(()=>{
  const request={...input,feedbackId};if(input.op==='save')checkRequestBudget(request);return call(request);
}).catch(error=>{
  if(input.op==='save'&&sourceId===state.feedbackId){
    state.saveError=error.message;
    // A failed copy still leaves the original record in conflict; retain its recovery action.
    if(feedbackId===sourceId)state.saveErrorCode=error.code;
  }
  throw error;
});
};
const button = (label, action, style = 'secondary', disabled = false) => el('button', { type: 'button', text: label, className: style, disabled: disabled || state.busy, onClick: () => run(action) });
const note = (text, className = 'hint') => el('p', { text, className });
function input(label, field, multiline = false, copy = false) {
  const shortTitle=field==='title'&&!copy;
  const control = el(multiline ? 'textarea' : 'input', { id: `feedback-${field}`, ...(multiline ? {} : { type: 'text' }), value: shortTitle?state.report.title.replace(/^(?:bug|feat):\s*/i,''):state.report[field], maxLength: field === 'title' ? 194 : 100000,
    placeholder:shortTitle?'留空时根据描述生成':multiline&&!copy?(state.report.kind==='feat'?'你希望增加什么功能？':'简单说说遇到了什么问题，也可以只添加图片。'):undefined,
    disabled: state.busy || locked(), onInput: event => { state.report[field] = shortTitle?`${state.report.kind??'bug'}: ${event.target.value}`:event.target.value; invalidate(); } });
  return el('div', { className: 'field' }, [el('div', { className: 'label' }, [el('label', { htmlFor: `feedback-${field}`, text: label }),
    ...(copy && multiline ? [button(state.preview ? '编辑正文' : '预览正文', async () => { state.preview = !state.preview; }, 'text')] : []),
    ...(copy ? [button(field === 'title' ? '复制标题' : '复制报告正文', async () => { if (state.dirty) await saveReview(); await bridge('clipboard.text', state.report[field]); state.feedbackNotice = '已复制'; }, 'text')] : [])]),
    copy && multiline && state.preview ? reportReader(state.report[field], el) : shortTitle?el('div',{className:'prefixed-title'},[el('span',{text:`${state.report.kind??'bug'}:`}),control]):control]);
}
function invalidate() {
  state.dirty = true; state.consent = false; state.automatic = false;
  state.routeDirty = true;
  app.dataset.reviewDirty = 'true';
  editVersion++;
  const status=document.querySelector('[data-save-status]');if(status)status.textContent=state.saveError||'草稿有更新，将自动保存';
  const contextNotice=document.querySelector('[data-context-notice]');
  if(contextNotice)contextNotice.hidden=!state.contextChanged;
  if(['edit','configure','review','handoff'].includes(state.stage)) {clearTimeout(draftTimer);draftTimer=setTimeout(()=>{pendingDraft=pendingDraft.then(()=>saveDraft()).catch(error=>{state.error=`草稿暂未保存：${error.message}`;render();});},500);}
  document.querySelectorAll('[data-consent]').forEach(node => { node.checked = false; });
  document.querySelectorAll('[data-publish]').forEach(node => { node.disabled = true; node.setAttribute('aria-disabled', 'true'); });
}
async function saveDraft(asNew=false) {
  if(!['edit','configure','review','handoff'].includes(state.stage)||(!state.dirty&&!asNew)||locked()||!hasDraft())return;
  const id=state.feedbackId, version=editVersion;
  const status=document.querySelector('[data-save-status]');if(status)status.textContent='正在保存草稿…';
  const saved=await recordCall({op:'save',draftOnly:asNew||['edit','configure'].includes(state.stage),targetId:state.targetId,clientId:state.clientId,projectRef:state.projectRef,linkedThreadId:state.linkedThread?.id??null,revision:asNew?undefined:state.revision,report:state.report},asNew?crypto.randomUUID():id);
  if(state.feedbackId!==id)return;
  state.journal=saved.journal;state.revision=saved.revision;state.saveError='';state.saveErrorCode='';state.selectionSaved=saved.selectionSaved;
  if(asNew){state.feedbackId=saved.journal.id;state.analysis=undefined;state.stage='edit';state.error='';}
  if(version===editVersion){
    state.dirty=false;
    if(!['edit','configure'].includes(state.stage)){
      state.report=saved.journal.report;
      ['title','body'].forEach(field=>{
        const control=document.getElementById(`feedback-${field}`);
        if(control)control.value=state.report[field];
      });
      document.querySelector('[aria-label="报告正文预览"]')?.replaceWith(reportPreview(state.report.body,el));
      app.querySelector('[data-report-reader]')?.dispatchEvent(new Event('report-updated'));
    }
  }
  if(status)status.textContent=version===editVersion?(saved.selectionSaved===false?'草稿已保存，可从反馈记录继续':'草稿已保存到反馈记录'):'草稿有更新，将自动保存';
}
function hasDraft(){return state.journal||state.dirty;}
async function flushDraft(){clearTimeout(draftTimer);await pendingDraft;await saveDraft();}
async function startNew(){
  analysisEpoch++;clearTimeout(analysisTimer);clearTimeout(historyTimer);await flushDraft();
  await call({op:'new'});
  Object.assign(state,{feedbackId:crypto.randomUUID(),report:{kind:'bug',title:'',body:'',attachments:[]},journal:undefined,revision:undefined,analysis:undefined,
    linkedThread:undefined,
    stage:'edit',dirty:false,consent:false,automatic:false,error:'',saveError:'',saveErrorCode:'',selectionSaved:true,projectRef:'',contextChanged:false,preview:true,
    reviewView:'report',reviewImage:0,reviewScroll:0,routeDirty:false,routeProblem:undefined,tokenIssue:undefined,githubCli:undefined,screenshotSelection:[],screenshotPreview:undefined,feedbackNotice:''});
}
async function showHistory(){
  analysisEpoch++;clearTimeout(analysisTimer);clearTimeout(historyTimer);await flushDraft();state.stage='history';state.draftToDelete=undefined;
  state.items=(await call({op:'history'})).items;historyTimer=setTimeout(refreshHistory,2000);
}
async function refreshHistory(){
  const epoch=analysisEpoch;if(state.stage!=='history')return;
  const value=await call({op:'history'}).catch(()=>undefined);
  if(state.stage!=='history'||epoch!==analysisEpoch)return;
  if(value&&JSON.stringify(value.items)!==JSON.stringify(state.items)){state.items=value.items;render();}
  historyTimer=setTimeout(refreshHistory,2000);
}
async function openRecord(id,value){
  analysisEpoch++;clearTimeout(analysisTimer);clearTimeout(historyTimer);await flushDraft();
  value??=await call({op:'bootstrap',feedbackId:id});
  Object.assign(state,value,{feedbackId:id,linkedThread:value.journal.linkedThread,report:{...value.journal.report,kind:value.journal.report.kind??(/^feat:/i.test(value.journal.report.title)?'feat':'bug')},
    targetId:value.journal.target.id,analysis:value.analysis,material:value.analysis?.material,hash:value.analysis?.hash,contextChanged:false,preflight:undefined,dirty:false,consent:false,automatic:false,error:'',saveError:'',saveErrorCode:'',selectionSaved:true,preview:true,
    reviewView:'report',reviewImage:0,reviewScroll:0,routeDirty:false,routeProblem:undefined,tokenIssue:undefined,githubCli:undefined,screenshotSelection:[],screenshotPreview:undefined,feedbackNotice:''});
  state.clientId=value.journal.clientId??value.analysis?.clientId??state.clientId;state.projectRef=value.journal.projectRef??value.analysis?.projectRef??'';
  const sameContext=matchesAnalysisContext(value.analysis);
  state.stage=value.journal.state==='published'?'published-report':value.journal.reviewReady||locked()?'review':'edit';
  if(value.journal.state!=='published'&&sameContext&&(!state.linkedThread||value.analysis?.journalDigest===value.journal.digest)&&['prepared','preparing','starting','running','blocked'].includes(value.analysis?.state)){
    state.material=value.analysis.material;state.hash=value.analysis.hash;state.stage=value.analysis.state==='prepared'?'scope':'analyzing';
    if(state.stage==='analyzing')analysisTimer=setTimeout(refreshAnalysis,1500);
  }else if(value.analysis?.state==='ready'&&!locked()){
    const matches=value.analysis.journalDigest===value.journal.digest&&sameContext;
    if(matches){state.report.title=value.analysis.title;state.report.body=value.analysis.body;await saveReview(false);}
  }
  if(state.stage==='review'&&!locked())await checkRoute();
  if(value.journal.state!=='published'&&['failed','interrupted'].includes(value.analysis?.state))state.error=value.analysis.error;
}
function matchesAnalysisContext(analysis) {
  return analysis && analysis.clientId===state.clientId && analysis.linkedThreadId===state.linkedThread?.id &&
    (analysis.projectRef||state.projectRoot||'')===(state.projectRef||state.projectRoot||'');
}
async function browseThreads(before) {
  await flushDraft();
  const page = await call({op:'list-threads',before});
  state.threadPage = page;
  state.stage = 'choose-thread';
}
async function showThread(thread, before) {
  await flushDraft();
  const page = await call({op:'thread-context',threadId:thread.id,before});
  state.threadContext = {thread, before, ...page};
  state.stage = 'thread-context';
}
async function selectThread(thread, sourceMessageId) {
  const previousId=state.linkedThread?.id;
  const saved=await recordCall({op:'save', draftOnly:!sourceMessageId, targetId:state.targetId, clientId:state.clientId, projectRef:'',
    revision:state.revision, linkedThreadId:thread?.id??null, report:state.report, sourceMessageId, sourceBefore:state.threadContext?.before});
  Object.assign(state,saved,{linkedThread:saved.journal.linkedThread,projectRef:saved.journal.projectRef??'',dirty:false,consent:false,
    stage:sourceMessageId?'review':'edit',saveError:'',saveErrorCode:''});
  if (previousId!==thread?.id || sourceMessageId) {
    analysisEpoch++;
    clearTimeout(analysisTimer);
    state.analysis=undefined; state.material=undefined; state.hash=undefined;
  }
  if (sourceMessageId) {
    state.report=saved.journal.report;
    state.preview=true; state.reviewView='report'; state.reviewScroll=0;
    await checkRoute();
  }
}
function renderThreadSync(content) {
  const { linkedThread, linkedIssueMessageId, issue, digest }=state.journal;
  if (!linkedThread || !issue) return;
  content.append(el('div',{className:'history-actions thread-link'},[
    note(`关联会话 · ${linkedThread.title || '未命名会话'}`),
    linkedIssueMessageId ? el('span',{className:'hint',role:'status',text:'Issue 链接已发回会话'}) :
      button('把 Issue 链接发回会话', async()=>{
        const result=await recordCall({op:'sync-thread-issue',digest,revision:state.revision});
        Object.assign(state,result);
      }),
    button('复制会话链接',()=>copyLink(linkedThread.deepLinkUrl),'text'),
  ]));
}
function locked() { return ['writing', 'unknown', 'published', 'upload_failed'].includes(state.journal?.state); }
function issueMayExist() { return ['writing', 'unknown'].includes(state.journal?.state); }
function check(label, key) {
  return el('label', { className: 'check' }, [el('input', { type: 'checkbox', checked: state[key], disabled: state.busy, 'data-consent': key,
    onChange: event => { state[key] = event.target.checked; render(); app.querySelector(`[data-consent="${key}"]`)?.focus(); } }), el('span', { text: label })]);
}
function pictureCards() {
  return el('div', { className: 'pictures', 'aria-label':'反馈图片' }, state.report.attachments.map((picture, index) => el('div', { className: 'picture' }, [
    el('img', { src: `data:${picture.mime};base64,${picture.base64}`, alt: `截图 ${index + 1}` }),
    el('div', {}, [...(state.stage==='edit'?[]:[button('复制图片', async () => { await copyImage(picture); state.error = '图片已复制，可粘贴到 Issue 页面'; }, 'text'),
      el('a', { text: '下载发送副本', href: `data:${picture.mime};base64,${picture.base64}`, download: picture.name, title: '已去除元数据的 PNG；这是自动提交的实际图片' }),
      ...(picture.original ? [el('a', { text: '下载原图', href: `data:${picture.original.mime};base64,${picture.original.base64}`, download: picture.original.name, title: '原图可能包含隐私元数据，自动提交不会上传原图' })] : [])]),
      ...(!locked() ? [el('button',{type:'button',text:'移除',className:'text','aria-label':`移除第 ${index+1} 张图片`,disabled:state.busy,onClick:()=>run(async()=>{state.report.attachments.splice(index,1);invalidate();})})] : [])]),
  ])));
}
async function addFiles(files) {
  const attachments = [...state.report.attachments];
  for (const file of files) {
    if (attachments.length >= 4 || file.size > 4000000 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('最多 4 张 PNG/JPEG/WebP，单张不超过 4 MB');
    const picture = await normalizePicture(file, attachments.length);
    const report = { ...state.report, attachments: [...attachments, picture] };
    const request = { op:'save', draftOnly:true, targetId:state.targetId,clientId:state.clientId,projectRef:state.projectRef,revision:state.revision,report,feedbackId:state.feedbackId };
    checkRequestBudget(request);
    if(report.attachments.reduce((sum,item)=>sum+atob(item.base64).length,0)>8_000_000)throw new Error('发送图片总大小不能超过 8 MB，请减少图片或裁剪');
    if(report.attachments.reduce((sum,item)=>sum+(item.original?atob(item.original.base64).length:0),0)>8_000_000)throw new Error('原图总大小不能超过 8 MB，请减少图片或裁剪');
    attachments.push(picture);
  }
  state.report.attachments=attachments;
  invalidate();
}
async function saveReview(checkTarget = true) {
  if(!['review','handoff'].includes(state.stage) || app.dataset.stage === 'analyzing'){
    Object.assign(state,{reviewView:'report',reviewImage:0,reviewScroll:0,preview:true});
  }
  await flushDraft();
  const saved = await recordCall({ op: 'save', targetId: state.targetId, clientId: state.clientId, projectRef: state.projectRef, linkedThreadId:state.linkedThread?.id??null, revision: state.revision, report: state.report });
  Object.assign(state, saved, { report: saved.journal.report, dirty: false, consent: false, stage: 'review',saveError:'',saveErrorCode:'' });
  state.automatic = false;
  if (checkTarget) await checkRoute();
}
async function checkRoute() {
  state.automatic=false;
  state.tokenIssue=undefined;
  state.githubCli=undefined;
  state.routeProblem=undefined;
  state.routeDirty=false;
  try {
    const preflight = await recordCall({ op: 'preflight', digest: state.journal.digest });
    state.preflight = preflight;
    state.automatic = !preflight.manualReason;
    if (!state.automatic) state.routeProblem = { kind:'manual', text:'此目标需要在网页手动创建。' };
  } catch (error) {
    if (error.code === 'feedback_token_missing' || error.code === 'feedback_token_invalid') {
      state.tokenIssue = error.code;
      state.githubCli = error.githubCli;
    } else state.routeProblem = { kind:'retry', text:error.message + '。也可手动创建。' };
  }
}
async function prepareAnalysis() {
  analysisEpoch++; clearTimeout(analysisTimer);
  // Persist the form first so a failed/cancelled client cannot lose the draft.
  await saveReview(false); state.error = '';
  const prepared = await recordCall({ op: 'prepare-analysis', report: state.report, logs: state.report.kind!=='feat', projectRef: state.projectRef, clientId:state.clientId, journalDigest:state.journal.digest });
  Object.assign(state, prepared, { stage: 'scope',contextChanged:false });
  if (!state.clients.some(c => c.id === state.clientId)) state.clientId = state.clients[0]?.id ?? '';
}
async function analyze() {
  analysisEpoch++;
  state.stage = 'analyzing'; render();
  try {
    const result = await recordCall({ op: 'analyze', clientId: state.clientId, hash: state.hash, confirmed: true });
    state.analysis = result.analysis;
    analysisTimer = setTimeout(refreshAnalysis, 1500);
  } catch (error) { state.stage = 'scope'; throw error; }
}
async function submit() {
  if (!state.automatic || !state.consent || state.dirty) throw new Error('请先检查提交方式，并确认完整内容和图片');
  state.stage = 'submitting'; render();
  try {
    const { digest } = state.journal;
    if (state.journal.state === 'draft') {
      Object.assign(state, await recordCall({ op: 'approve', digest, revision:state.revision, confirmed: true }));
    }
    Object.assign(state, await recordCall({ op: 'submit', digest }));
    state.screenshotSelection=[];
    state.stage = state.journal.state === 'published' ? 'submitted' : 'review';
  } catch (error) {
    state.stage = 'review';
    if (error.code !== 'feedback_token_missing' && error.code !== 'feedback_token_invalid') {
      if (!locked()) await checkRoute();
      throw error;
    }
    state.automatic = false;
    state.consent = false;
    state.tokenIssue = error.code;
    state.githubCli = error.githubCli;
  }
}
function run(action) {
  if (state.busy) return;
  state.busy = true; state.error = ''; state.feedbackNotice=''; render();
  pendingAction = Promise.resolve().then(action).catch(error => { state.error = error.message || '操作未完成，草稿已保留'; })
    .finally(() => { state.busy = false; render(); });
  return pendingAction;
}
async function refreshAnalysis() {
  if (state.stage !== 'analyzing') return;
  const recordId=state.feedbackId; const epoch = analysisEpoch; const runId = state.analysis?.id; const sourceDigest = state.journal?.digest;
  const current = () => state.stage === 'analyzing' && state.feedbackId===recordId && analysisEpoch === epoch && state.analysis?.id === runId && state.journal?.digest === sourceDigest;
  try {
    const { analysis } = await recordCall({ op: 'analysis-status' });
    if (!current()) return;
    if (analysis?.id !== runId) { state.stage = 'scope'; state.error = '分析已在其他窗口变化，请重新打开检查。'; render(); return; }
    state.analysis = analysis;
    if (analysis?.state === 'ready') {
      state.report.title = analysis.title; state.report.body = analysis.body; state.dirty = true;
      state.stage = 'review';
      await run(saveReview);
      return;
    }
    if (['failed', 'cancelled', 'interrupted'].includes(analysis?.state)) {
      state.error = analysis.error ?? '已停止等待，草稿已保留。'; state.stage = 'scope'; render(); return;
    }
    const progress = document.querySelector('[data-analysis-progress]');
    if (progress) progress.textContent = analysis?.progress ?? '请求已发送，等待 Agent 开始分析';
    const elapsed = document.querySelector('[data-analysis-elapsed]');
    if (elapsed) elapsed.textContent = `已等待 ${Math.max(0, Math.floor((Date.now() - (analysis?.startedAt ?? Date.now())) / 1000))} 秒${analysis?.receivedChars ? ` · 已收到 ${analysis.receivedChars} 字回复` : ''}。完成后会自动展示报告，可关闭面板稍后回来。`;
  } catch (error) {
    if (!current()) return;
    const progress = document.querySelector('[data-analysis-progress]');
    if (progress) progress.textContent = '暂时无法获取进展，正在重试；原分析不会重复发起。';
  }
  if (current()) analysisTimer = setTimeout(refreshAnalysis, 1500);
}
function renderReview(content, footer) {
  const attachments = state.report.attachments;
  const deliveryView = state.reviewView !== 'report';
  const showImages = state.reviewView === 'images' && attachments.length > 0;
  const selectView = (section,selector) => {
    state.reviewView=section;render();app.querySelector(selector)?.focus();
  };
  const reviewTabs = el('nav', { className:'review-tabs', 'aria-label':'核对内容' }, [
    ['report', '报告'], ['delivery', attachments.length ? '截图与提交' : '提交'],
  ].map(([section,label]) => el('button', { type:'button', text:label, 'aria-pressed':section === (deliveryView?'delivery':'report'),
    'data-review-view':section,onClick:()=>selectView(section,`[data-review-view="${section}"]`) })));
  const documentArea = el('section', { className:'review-document', 'aria-label':showImages?'检查截图':'检查报告' });
  const index = Math.min(state.reviewImage,attachments.length-1);
  const source = image => `data:${image.mime};base64,${image.base64}`;
  const photos = attachments.length ? el('section',{className:'review-photo-picker','aria-label':'截图'},[
    el('h2',{text:`截图（${attachments.length}）`}),
    el('div',{className:'review-thumbnails'},attachments.map((image,i)=>
      el('button',{type:'button',className:'picture review-thumbnail','aria-label':`查看第 ${i+1} 张截图`,
        'aria-pressed':showImages && index===i,'data-review-image':i,onClick:()=>{
          state.reviewImage=i;selectView('images','.review-image-heading h2');
        }},[el('img',{src:source(image),alt:''})]))),
  ]) : undefined;

  if (showImages) {
    const picture = attachments[index];
    documentArea.append(el('div',{className:'review-image-heading'},[
      el('h2',{tabIndex:-1,text:`截图 ${index+1} / ${attachments.length}`}),
      el('button',{type:'button',className:'text review-return-report',text:'返回报告',onClick:()=>selectView('report','#feedback-title')}),
      el('button',{type:'button',className:'text review-return-delivery',text:'返回截图与提交',
        onClick:()=>selectView('delivery',`[data-review-image="${index}"]`)}),
    ]),el('div',{className:'review-image-stage'},[
      el('img',{src:source(picture),alt:`截图 ${index+1}`}),
    ]),el('div',{className:'review-image-actions'},[
      button('复制图片',async()=>{await copyImage(picture);state.feedbackNotice='图片已复制';},'text'),
      el('a',{text:'下载发送副本',href:source(picture),download:picture.name}),
      ...(picture.original?[el('a',{text:'下载原图',href:source(picture.original),download:picture.original.name})]:[]),
      ...(!locked()?[button('移除截图',async()=>{
        attachments.splice(index,1);if(!attachments.length)state.reviewView='delivery';invalidate();
      },'text')]:[]),
    ]));
    if (attachments.length>1) documentArea.append(el('div',{className:'review-photo-nav','aria-label':'浏览截图'},[
      el('button',{type:'button',className:'text',text:'上一张',disabled:index===0,onClick:()=>{
        state.reviewImage=index-1;selectView('images','.review-image-heading h2');
      }}),
      el('button',{type:'button',className:'text',text:'下一张',disabled:index===attachments.length-1,onClick:()=>{
        state.reviewImage=index+1;selectView('images','.review-image-heading h2');
      }}),
    ]));
  } else {
    documentArea.append(input('Issue 标题','title',false,true),input('报告正文','body',true,true));
  }

  const target = state.journal?.target;
  const visibility = target?.visibility === 'public' ? '公开可见' : target?.visibility === 'private' ? '私有' : '可见性未知';
  const route = el('aside',{className:'review-route','aria-label':'提交信息'},[
    el('h2',{text:'提交目标'}),
  ]);
  if (state.targets.length > 1 && !locked()) {
    const select = el('select',{'aria-label':'反馈目标',disabled:state.busy,
      onChange:event=>run(async()=>{state.targetId=event.target.value;invalidate();await saveReview();})},
    state.targets.map(value=>el('option',{value:value.id,text:value.label})));
    select.value=state.targetId;
    route.append(select);
  } else route.append(el('p',{className:'review-target-name',text:target?.label??''}));
  route.append(note(visibility,'review-visibility'));
  if (!locked() && state.automatic && state.preflight?.githubAuth) {
    const {githubAuth, principal} = state.preflight;
    route.append(note(githubAuth==='cli' ? `使用 GitHub CLI（@${principal}）` : '使用已配置的 GitHub 令牌','review-visibility'));
  }
  if (!locked() && state.tokenIssue) {
    const name=target.provider==='gitlab'?'GitLab':'GitHub';
    const missing=state.tokenIssue==='feedback_token_missing';
    const cliHelp = {unavailable:'未找到 GitHub CLI。可先配置令牌，或安装并登录 GitHub CLI。',
      login:'也可在本机终端运行 gh auth login，登录后回来重新检查。',
      rejected:'GitHub CLI 登录未获接受。可用 gh auth login 重新登录。'}[state.githubCli];
    route.append(el('div',{className:'review-route-condition'},[
      note(missing?(cliHelp?'登录 GitHub CLI 或配置访问令牌即可自动提交。':'自动提交需要访问令牌。')
        :'当前凭据未获接受，请更新后重试。'),
      note(`打开设置 → 插件 → 问题反馈，${missing?'配置':'更新'} ${name} 访问令牌。草稿会自动保存。`,'hint'),
      ...(cliHelp?[note(cliHelp,'hint review-cli-help')]:[]),
      button('重新检查',saveReview),
    ]));
  } else if (!locked() && state.routeProblem) {
    route.append(el('div',{className:'review-route-condition'},[
      note(state.routeProblem.text),
      ...(state.routeProblem.kind==='retry'?[el('div',{className:'review-route-retry'},[
        button('重新检查',checkRoute),
      ])]:[]),
    ]));
  }
  if (!locked() && state.automatic) {
    route.append(note('截图可能含有个人信息，默认不发送。Issue 创建后可选择上传。','review-route-condition hint'));
  }
  if (!locked()) route.append(el('div',{className:'review-recheck'},[
    note('报告有改动，保存后可重新检查自动提交条件。'),
    button('保存并检查',saveReview),
  ]));
  if (state.stage === 'handoff') route.append(note('在浏览器打开目标地址后，请粘贴报告和截图并提交。','review-route-condition hint'));
  if (state.journal?.state === 'upload_failed') route.append(note(state.journal.safeError,'review-route-condition hint'));
  else if (issueMayExist()) route.append(note('提交结果待核对。核对操作不会重新提交。','review-route-condition hint'));
  if (state.journal?.issue && issueMayExist()) route.append(button('复制待核验的 Issue 链接',()=>copyLink(state.journal.issue.url),'text'));
  if (state.stage === 'submitting') route.append(note('正在提交并核验回执…','review-route-condition hint'));

  content.append(reviewTabs,el('div',{className:'review-layout','data-delivery':deliveryView,'data-has-images':showImages},[
    documentArea,el('div',{className:'review-side'},[...(photos?[photos]:[]),route]),
  ]));

  const actions = el('div',{className:'review-actions'});
  if (!locked() && state.stage !== 'submitting') {
    const manual=button('复制手动创建链接',async()=>{
      Object.assign(state,await recordCall({op:'manual',digest:state.journal.digest}));
      state.stage='handoff';
      await copyLink(target.issueCreateUrl);
    },state.routeProblem?.kind==='manual'?'primary':'text',!target||!state.consent||state.dirty||issueMayExist());
    manual.dataset.publish='manual';
    actions.append(manual);
    if (state.automatic) {
      const submitButton=button('提交正文',submit,'primary',!state.consent||state.dirty);
      submitButton.dataset.publish='auto';
      actions.append(submitButton);
    }
  }
  if (state.journal?.state === 'upload_failed') {
    actions.append(button('保留回执，返回编辑',async()=>{
      Object.assign(state,await recordCall({op:'reset-upload',digest:state.journal.digest,confirmed:true}));
      state.feedbackId=state.journal.id;state.analysis=undefined;state.stage='edit';state.consent=false;state.dirty=false;
    },'primary'));
  } else if (issueMayExist() && state.stage !== 'submitting') {
    actions.append(button('核对提交结果',async()=>{
      const value=await recordCall({op:'reconcile',digest:state.journal.digest});Object.assign(state,value);state.error=value.message??'';
      if(value.journal.state==='published')state.stage='submitted';
    },'primary'));
  }
  if (!locked() && state.stage !== 'submitting') {
    footer.append(check(`我已检查报告，同意将正文提交至「${target?.label??''}」`,'consent'));
  }
  footer.append(el('div',{className:'review-footer-row'},[
    !locked()&&state.stage!=='submitting' ? button('返回填写',async()=>{state.stage='edit';state.consent=false;},'text') : el('span'),
    ...(state.feedbackNotice?[el('span',{className:'hint',role:'status',text:state.feedbackNotice})]:[]),
    el('button',{type:'button',className:'primary review-next',text:attachments.length?'下一步：截图与提交':'下一步：提交',
      onClick:()=>selectView('delivery','[data-review-view="delivery"]')}),
    actions,
  ]));
}
function publishedScreenshotItems() {
  const journal = state.journal;
  return journal.screenshotItems ?? (journal.addScreenshotsLater && !journal.screenshotsConfirmed ? journal.report.attachments : []);
}
async function changePublishedScreenshots(op, data = {}) {
  const {digest} = state.journal;
  const value = await recordCall({op,digest,revision:state.revision,...data});
  Object.assign(state,value);
  state.feedbackNotice = value.message ?? '';
}
function renderPublishedScreenshots(content) {
  const {issue,target,screenshotSent = [],screenshotAttempt} = state.journal;
  const awaitingScreenshotCheck = screenshotAttempt && !screenshotAttempt.retryConfirmed;
  const items = publishedScreenshotItems();
  const selected = state.screenshotSelection ?? [];
  const preview = items.find(item=>item.sha256===state.screenshotPreview);
  const section = el('section',{className:'supplemental','aria-label':'补充截图（可选）'},[
    el('h2',{text:'补充截图（可选）'}),
    note(target.visibility==='public' ? '截图可能含有个人信息。请检查后再上传，所选截图会公开显示在此 Issue 的评论中。'
      : '截图可能含有个人信息。请检查后再上传，所选截图将添加到此 Issue 的评论中。'),
  ]);
  if (preview) {
    section.append(button('返回选图',async()=>{state.screenshotPreview=undefined;},'text'),
      el('img',{className:'supplemental-preview',src:`data:${preview.mime};base64,${preview.base64}`,alt:'截图预览'}));
  } else {
    const cards = items.map((picture,index)=>{
      const hash = picture.sha256;
      const sent = screenshotSent.includes(hash);
      return el('div',{className:'supplemental-card'},[
        el('button',{type:'button',className:'supplemental-thumb', 'aria-label':`预览截图 ${index + 1}`,onClick:()=>{
          state.screenshotPreview=hash;render();app.querySelector('.supplemental button')?.focus();
        }},[el('img',{src:`data:${picture.mime};base64,${picture.base64}`,alt:''})]),
        el('label',{className:'check'},[
          el('input',{type:'checkbox',checked:sent||selected.includes(hash),disabled:sent||!!awaitingScreenshotCheck||state.busy,
            'data-screenshot-choice':index,onChange:event=>{
              state.screenshotSelection=event.target.checked?[...selected,hash]:selected.filter(value=>value!==hash);
              render();app.querySelector(`[data-screenshot-choice="${index}"]`)?.focus();
            }}),el('span',{text:sent?`截图 ${index + 1} 已上传`:`选择截图 ${index + 1}`}),
        ]),
        ...(!sent&&!awaitingScreenshotCheck?[button('移出候选',async()=>{
          await changePublishedScreenshots('remove-screenshot',{hash});
          state.screenshotSelection=selected.filter(value=>value!==hash);
        },'text')]:[]),
      ]);
    });
    if (cards.length) section.append(el('div',{className:'supplemental-cards'},cards));
    if (awaitingScreenshotCheck) {
      section.append(note('上次上传结果待核对。若已在原 Issue 确认没有这批截图，可重新选择。'),
        el('div',{className:'supplemental-actions'},[
          button('核对截图上传结果',()=>changePublishedScreenshots('check-screenshots'),'primary'),
          button('确认未上传，重新选择',async()=>{
            await changePublishedScreenshots('retry-screenshots',{confirmed:true});
            state.screenshotSelection=[];
          },'text'),
        ]));
    } else {
      if (state.journal.screenshotCommentUnverified && !state.journal.screenshotsConfirmed) {
        section.append(note('旧版截图上传记录待核对。请查看原 Issue 的评论。'),
          button('我已核对旧版截图',()=>changePublishedScreenshots('confirm-screenshots',{confirmed:true}),'text'));
      }
      const pick = el('label',{className:'secondary add-picture',text:'选择本地图片'});
      const picker = el('input',{type:'file',accept:'image/png,image/jpeg,image/webp',multiple:true,
        'aria-label':'选择本地图片',disabled:state.busy||items.length>=4,onChange:event=>{
          const files=Array.from(event.target.files);
          if (!files.length) return;
          void run(async()=>{
            if (items.length + files.length > 4) throw new Error('最多保留 4 张截图，可先移出不需要的候选。');
            const pictures=await Promise.all(files.map(async (file,index)=>{
              if (file.size>4_000_000 || !['image/png','image/jpeg','image/webp'].includes(file.type)) throw new Error('请选择单张不超过 4 MB 的图片。');
              const {original,...picture}=await normalizePicture(file,items.length+index);
              return picture;
            }));
            checkRequestBudget({op:'add-screenshots',pictures});
            const previous = new Set(items.map(item=>item.sha256));
            await changePublishedScreenshots('add-screenshots',{pictures});
            state.screenshotSelection=[...selected,...publishedScreenshotItems().filter(item=>!previous.has(item.sha256)).map(item=>item.sha256)];
          });
        }});
      pick.append(picker);
      const upload = button(selected.length?`上传所选截图（${selected.length}）`:'上传所选截图',async()=>{
        try {
          await changePublishedScreenshots('upload-screenshots',{hashes:selected,confirmed:true});
          state.screenshotSelection=[];
        } catch (error) {
          if (error.code === 'feedback_token_missing' || error.code === 'feedback_token_invalid') state.tokenIssue=error.code;
          throw error;
        }
      },'primary',!selected.length);
      section.append(el('div',{className:'supplemental-actions'},[...(items.length<4?[pick]:[]),upload]));
      if (state.tokenIssue && ['github','gitlab'].includes(target.provider)) {
        const name=target.provider==='gitlab'?'GitLab':'GitHub';
        section.append(note(`请在设置 → 插件 → 问题反馈中更新 ${name} 访问令牌，再从反馈记录打开这条 Issue 补充截图。`,'hint'));
      }
    }
  }
  if(state.feedbackNotice) section.append(el('p',{className:'hint',role:'status',text:state.feedbackNotice}));
  content.append(el('div',{className:'issue-confirmed'},[
    el('h2',{text:'Issue 已创建'}),
    button(`复制 Issue #${issue.id} 链接`,()=>copyLink(issue.url),'text'),
  ]),section);
}
function render() {
  unbindReader?.();
  const scroll = app.dataset.stage === state.stage ? app.querySelector('.content')?.scrollTop ?? 0 : 0;
  const stageIndex = state.stage === 'edit' ? 0 : ['configure','scope', 'analyzing'].includes(state.stage) ? 1 : ['review','handoff', 'submitting'].includes(state.stage) ? 2 : 3;
  const header = el('header', {}, [el('div',{className:'heading-row'},[
    el('div',{},[el('h1',{text:state.stage==='history'?'反馈记录':state.stage==='choose-thread'?'关联已有会话':state.stage==='thread-context'?'会话中的反馈':'问题反馈'}),
      ...(!['choose-thread','thread-context'].includes(state.stage)?[note(state.stage==='edit'?'描述问题，图片可选。':state.stage==='history'?'草稿、分析和投递进度都在这里。':state.stage==='published-report'?'投递时的报告':state.stage==='published-screenshots'?'补充截图':['填写问题','分析与脱敏','检查与提交','反馈完成'][stageIndex])]:[])]),
    el('div',{className:'feedback-nav'},[button('新建反馈',startNew,'text'),button('反馈记录',showHistory,'secondary')])])]);
  const content = el('section', { className: 'content' }); const footer = el('footer');
  if (state.error) content.append(el('p', { role: 'alert', className: 'error', text: state.error }));
  if (state.feedbackNotice && ['scope','analyzing','published-report','thread-context'].includes(state.stage)) {
    content.append(el('p',{role:'status',className:'hint',text:state.feedbackNotice}));
  }
  if(['edit','configure','review','handoff'].includes(state.stage)){
    footer.append(el('span',{'data-save-status':'',className:state.saveError?'error':'hint',text:state.saveError||
      (state.selectionSaved===false?'草稿已保存，可从反馈记录继续':state.journal&&!state.dirty?'草稿已保存到反馈记录':hasDraft()?'草稿有更新，将自动保存':'')}));
    if(state.saveErrorCode==='revision_conflict')footer.append(button('另存为新草稿',()=>saveDraft(true)));
  }
  if (state.stage === 'history') {
    if(state.feedbackNotice)content.append(el('p',{role:'status',className:'hint',text:state.feedbackNotice}));
    content.append(feedbackHistory(state.items,{
      open:id=>run(()=>openRecord(id)),copyUrl:url=>run(()=>copyLink(url)),deleteId:state.draftToDelete?.id,busy:state.busy,
      requestDelete:({id,deleteRevision})=>{
        state.draftToDelete={id,revision:deleteRevision};
        render();app.querySelector('[data-cancel-draft-delete]')?.focus();
      },
      cancelDelete:()=>{
        const {id}=state.draftToDelete;
        state.draftToDelete=undefined;
        render();app.querySelector(`[data-feedback-id="${id}"] [data-delete-draft]`)?.focus();
      },
      confirmDelete:()=>run(async()=>{
        const {id,revision}=state.draftToDelete;
        // Invalidate any history refresh already in flight before adopting the deletion result.
        analysisEpoch++;clearTimeout(historyTimer);
        try{
          const value=await recordCall({op:'delete-draft',revision,confirmed:true},id);
          state.items=value.items;
          state.feedbackNotice='草稿已删除';
        }finally{
          state.draftToDelete=undefined;
          historyTimer=setTimeout(refreshHistory,2000);
        }
      }),
    }));
    footer.append(button('刷新记录',showHistory),button('新建反馈',startNew,'primary'));
  } else if (state.stage === 'edit') {
    const linked = state.linkedThread;
    const threadControl = linked ? button(`会话：${linked.title || '未命名会话'}`,()=>showThread(linked),'text thread-name') :
      button('关联已有会话',()=>browseThreads(),'text');
    content.append(...feedbackForm(state,{input,note,button,pictureCards,addFiles,invalidate,run,render,threadControl}));
    footer.append(button('保存草稿',flushDraft,'text'),button('直接反馈',saveReview),button(linked?'在原会话分析':'生成分析报告',async()=>{await flushDraft();state.stage='configure';},'primary'));
    if(state.analysis?.state==='ready'&&matchesAnalysisContext(state.analysis))footer.append(button('查看本条分析报告',async()=>{state.report.title=state.analysis.title;state.report.body=state.analysis.body;await saveReview();},'text'));
  } else if (state.stage === 'choose-thread') {
    const { items, next }=state.threadPage;
    const entries=items.map(thread=>el('li',{},[
      button(thread.title || '未命名会话',()=>showThread(thread)),
      note(new Date(thread.lastActiveAt).toLocaleString('zh-CN')),
    ]));
    const empty=el('p',{className:'hint',role:'status',text:'本页没有匹配的会话。',hidden:entries.length>0});
    if(entries.length) content.append(el('input',{type:'text',className:'thread-filter',placeholder:'按标题筛选本页会话','aria-label':'筛选本页会话',onInput:event=>{
      const query=event.target.value.trim().toLocaleLowerCase();
      entries.forEach((entry,index)=>{entry.hidden=!(items[index].title||'未命名会话').toLocaleLowerCase().includes(query);});
      empty.hidden=entries.some(entry=>!entry.hidden);
    }}));
    content.append(empty,el('ul',{className:'thread-picker'},entries));
    footer.append(button('返回反馈',async()=>{state.stage='edit';},'text'));
    if(next)footer.append(button('更早的会话',()=>browseThreads(next)));
  } else if (state.stage === 'thread-context') {
    const { thread, feedback, messages, next }=state.threadContext;
    const linked=state.linkedThread?.id===thread.id;
    content.append(el('h2',{className:'thread-title',text:thread.title || '未命名会话'}),
      feedback.length ? el('details',{className:'thread-history'},[
        el('summary',{text:`历史反馈（${feedback.length}）`}),
        el('ul',{className:'thread-picker'},feedback.map(item=>el('li',{},[
          el('span',{text:item.title}),
          item.issueUrl ? button(`复制 Issue #${item.issueId} 链接`,()=>copyLink(item.issueUrl),'text') : note('尚未投递'),
        ]))),
      ]) : note('这个会话还没有反馈记录。'),
      el('h3',{text:'使用已有分析'}),
      note('选一条回复填入草稿，再检查将要提交的内容。'),
      messages.length ? el('ul',{className:'thread-picker'},messages.map(message=>el('li',{},[
        el('div',{className:'thread-excerpt'},[note(new Date(message.timestamp).toLocaleString('zh-CN')),el('p',{text:message.excerpt})]),
        button('用作反馈草稿',()=>selectThread(thread,message.id)),
      ]))) : note('这一页没有可用的成员回复。'));
    if(next)content.append(button('更早的回复',()=>showThread(thread,next)));
    footer.append(button('选择其他会话',()=>browseThreads(),'text'),
      linked ? button('解除关联',()=>selectThread(undefined),'text') : button('关联此会话',()=>selectThread(thread),'primary'));
    if(linked)footer.append(button('返回反馈',async()=>{state.stage='edit';}));
  } else if(state.stage==='configure') {
    content.append(analysisSettings(state,{invalidate,note}));
    if(!state.clients.length)content.append(note('还没有可用的分析成员，请先在宿主设置中配置 Agent Client。也可以跳过分析，直接反馈。','notice'));
    content.append(el('p',{'data-context-notice':'',role:'status',className:'notice',text:'分析上下文已改变，需要重新分析。现有正文会保留，便于继续编辑。',hidden:!state.contextChanged}));
    footer.append(button('返回填写',async()=>{await flushDraft();state.stage='edit';},'text'),button('跳过分析',saveReview),button('准备分析材料',prepareAnalysis,'primary',!state.clients.some(client=>client.id===state.clientId)));
  } else if (['scope', 'analyzing'].includes(state.stage)) {
    const client = state.clients.find(c=>c.id===(state.analysis?.clientId??state.clientId));
    content.append(el('div', { className: 'notice', text: `分析成员：${client?.label ?? '已选成员'} · ${client?.model ?? ''}。${state.report.kind === 'feat' ? '版本和功能建议' : '版本、问题描述及近期错误线索'}先在本地脱敏，再交给该成员分析；如其模型在云端，脱敏材料会发送到该模型。截图不交给模型。` }),
      note('仅生成报告，不执行修复或创建 Issue。完成后会再次脱敏，并展示完整标题和正文供你检查。'),
      el('details',{},[el('summary',{text:'查看将发送的脱敏材料'}),el('textarea', { className: 'material', value: state.material, readOnly: true, 'aria-label': '脱敏分析材料' })]));
    if (state.stage === 'analyzing') content.append(el('div',{className:'analysis-progress',role:'status','aria-live':'polite'},[
      el('p',{'data-analysis-progress':'',text:state.analysis?.progress ?? '请求已发送，等待 Agent 开始分析'}),
      el('p',{'data-analysis-elapsed':'',className:'hint',text:'完成后会自动展示报告，可关闭面板稍后回来。'})]));
    if (state.analysis?.threadUrl) content.append(button(state.linkedThread?'复制原会话链接':'复制分析会话链接',()=>copyLink(state.analysis.threadUrl),'text'));
    if (['blocked', 'preparing'].includes(state.analysis?.state)) content.append(note(state.analysis.error || 'Client 需要处理，请打开分析对话。', 'notice'));
    if (state.stage === 'analyzing') footer.append(button('停止等待，保留草稿', async () => { analysisEpoch++; clearTimeout(analysisTimer); const result = await recordCall({ op: 'cancel-analysis' }); state.analysis = result.analysis; state.stage = 'scope'; state.error = '已停止等待；这不会强制终止 Client，可打开分析对话查看。'; }));
    else footer.append(button('更改分析设置',async()=>{state.stage='configure';},'text'),button('跳过分析', saveReview), ['failed', 'cancelled', 'interrupted'].includes(state.analysis?.state)
      ? button('重新准备材料', prepareAnalysis, 'primary') : button('开始分析', analyze, 'primary', !state.clientId));
  } else if (['review', 'handoff', 'submitting'].includes(state.stage)) {
    content.className='content review-content';
    footer.className='review-footer';
    renderReview(content,footer);
  } else if (state.stage === 'published-report') {
    const { issue, report } = state.journal;
    content.className = 'content review-content published-report';
    content.append(el('div',{className:'issue-confirmed published-heading'},[
      el('h2',{text:report.title}),
      ...(issue?[button(`复制 Issue #${issue.id} 链接`,()=>copyLink(issue.url),'text')]:[]),
    ]));
    renderThreadSync(content);
    content.append(report.body.trim()?reportReader(report.body,el):note('这条反馈没有正文。','hint'));
    footer.append(button('返回记录',showHistory,'text'));
    if (issue) footer.append(button('补充截图',async()=>{state.stage='published-screenshots';}));
  } else if (state.stage === 'submitted' || state.stage === 'published-screenshots') {
    if(state.stage==='submitted')renderThreadSync(content);
    renderPublishedScreenshots(content);
    if (state.stage === 'published-screenshots') footer.append(button('返回投递报告',async()=>{state.stage='published-report';}));
    else footer.append(button('继续反馈', startNew,'text'), button('完成', () => bridge('close')));
  }
  app.replaceChildren(header, content, footer);
  app.dataset.stage = state.stage; content.scrollTop = state.error?0:scroll;
  app.dataset.reviewDirty = String(state.routeDirty);
  app.dataset.reviewDelivery = String(state.reviewView!=='report');
  app.dataset.reviewImageView = String(state.reviewView==='images' && state.report.attachments.length>0);
  const reader=app.querySelector('[data-report-reader]');
  if(reader) unbindReader=bindReportReader(reader,state.reviewScroll,position=>{state.reviewScroll=position;});
  else unbindReader=undefined;
}
render();
app.addEventListener('paste', event => {
  if(state.stage!=='edit'||state.busy||locked())return;
  const files=Array.from(event.clipboardData?.items??[]).filter(item=>item.type.startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean);
  if(!files.length)return;
  event.preventDefault();
  return run(()=>addFiles(files));
});
beforeClose(async()=>{
  await pendingAction;
  await run(async()=>{
    try { await flushDraft(); void bridge('close'); }
    catch(error) { await bridge('close.cancel'); throw error; }
  });
}).catch(error=>{state.error=`关闭前自动保存不可用，请更新宿主：${error.message}`;render();});
run(async()=>{
  const initial=await call({op:'bootstrap',resume:true});state.targets=initial.targets;state.clients=initial.clients??[];state.items=initial.items??[];
  state.clientId=state.clients[0]?.id??'';state.targetId=state.targets[0]?.id??'';
  if(initial.journal)await openRecord(initial.journal.id,initial);
});
