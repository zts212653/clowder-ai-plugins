import { bridge, call, copyImage, el, normalizePicture } from './bridge.js';
import { reportPreview } from './report.js';
import { feedbackForm } from './form.js';
import { feedbackHistory } from './history.js';

const app = document.getElementById('app');
const state = { stage: 'edit', feedbackId:crypto.randomUUID(), items:[], report: { kind:'bug', title: '', body: '', attachments: [] }, targets: [], targetId: '', clients: [], clientId: '',
  consent: false, busy: false, error: '', dirty: true, automatic: false, projectRef: '', analysis: undefined, preview: true };
let analysisTimer;
let analysisEpoch = 0;
let historyTimer, draftTimer;
let pendingDraft=Promise.resolve();
let editVersion=0;
const recordCall = input=>call({...input,feedbackId:state.feedbackId});
const button = (label, action, style = 'secondary', disabled = false) => el('button', { type: 'button', text: label, className: style, disabled: disabled || state.busy, onClick: () => run(action) });
const note = (text, className = 'hint') => el('p', { text, className });
function input(label, field, multiline = false, copy = false) {
  const shortTitle=field==='title'&&!copy;
  const control = el(multiline ? 'textarea' : 'input', { id: `feedback-${field}`, ...(multiline ? {} : { type: 'text' }), value: shortTitle?state.report.title.replace(/^(?:bug|feat):\s*/i,''):state.report[field], maxLength: field === 'title' ? 194 : 100000,
    placeholder:shortTitle?'留空时根据描述生成':multiline&&!copy?(state.report.kind==='feat'?'你希望增加什么功能？':'简单说说遇到了什么问题，也可以只添加图片。'):undefined,
    disabled: state.busy || locked(), onInput: event => { state.report[field] = shortTitle?`${state.report.kind??'bug'}: ${event.target.value}`:event.target.value; invalidate(); } });
  return el('div', { className: 'field' }, [el('div', { className: 'label' }, [el('label', { htmlFor: `feedback-${field}`, text: label }),
    ...(copy && multiline ? [button(state.preview ? '编辑正文' : '预览正文', async () => { state.preview = !state.preview; }, 'text')] : []),
    ...(copy ? [button(field === 'title' ? '复制标题' : '复制报告正文', async () => { if (state.dirty) await saveReview(); await bridge('clipboard.text', state.report[field]); state.error = '已复制'; }, 'text')] : [])]),
    copy && multiline && state.preview ? reportPreview(state.report[field], el) : shortTitle?el('div',{className:'prefixed-title'},[el('span',{text:`${state.report.kind??'bug'}:`}),control]):control]);
}
function invalidate() {
  state.dirty = true; state.consent = false; state.automatic = false;
  editVersion++;
  const status=document.querySelector('[data-save-status]');if(status)status.textContent='尚未保存，关闭前请保存';
  if(state.stage==='edit') {clearTimeout(draftTimer);draftTimer=setTimeout(()=>{pendingDraft=pendingDraft.then(saveDraft).catch(error=>{state.error=`草稿暂未保存：${error.message}`;render();});},500);}
  document.querySelectorAll('[data-consent]').forEach(node => { node.checked = false; });
  document.querySelectorAll('[data-publish]').forEach(node => { node.disabled = true; node.setAttribute('aria-disabled', 'true'); });
}
async function saveDraft() {
  if(state.stage!=='edit'||!state.dirty||locked()||!hasDraft())return;
  const id=state.feedbackId, version=editVersion;
  const status=document.querySelector('[data-save-status]');if(status)status.textContent='正在保存草稿…';
  const saved=await recordCall({op:'save',draftOnly:true,targetId:state.targetId,revision:state.revision,report:state.report});
  if(state.feedbackId!==id)return;
  state.journal=saved.journal;state.revision=saved.revision;
  if(version===editVersion)state.dirty=false;
  if(status)status.textContent=version===editVersion?'草稿已保存到反馈记录':'尚未保存，关闭前请保存';
}
function hasDraft(){return state.journal||state.report.title.replace(/^(?:bug|feat):\s*/i,'').trim()||state.report.body.trim()||state.report.attachments.length;}
async function flushDraft(){clearTimeout(draftTimer);await pendingDraft;await saveDraft();}
async function startNew(){
  analysisEpoch++;clearTimeout(analysisTimer);clearTimeout(historyTimer);await flushDraft();
  Object.assign(state,{feedbackId:crypto.randomUUID(),report:{kind:'bug',title:'',body:'',attachments:[]},journal:undefined,revision:undefined,analysis:undefined,
    stage:'edit',dirty:true,consent:false,automatic:false,error:'',projectRef:'',preview:true});
}
async function showHistory(){
  analysisEpoch++;clearTimeout(analysisTimer);clearTimeout(historyTimer);await flushDraft();state.stage='history';
  state.items=(await call({op:'history'})).items;historyTimer=setTimeout(refreshHistory,2000);
}
async function refreshHistory(){
  const epoch=analysisEpoch;if(state.stage!=='history')return;
  const value=await call({op:'history'}).catch(()=>undefined);
  if(state.stage!=='history'||epoch!==analysisEpoch)return;
  if(value&&JSON.stringify(value.items)!==JSON.stringify(state.items)){state.items=value.items;render();}
  historyTimer=setTimeout(refreshHistory,2000);
}
async function openRecord(id){
  analysisEpoch++;clearTimeout(analysisTimer);clearTimeout(historyTimer);await flushDraft();
  const value=await call({op:'bootstrap',feedbackId:id});
  Object.assign(state,value,{feedbackId:id,report:{...value.journal.report,kind:value.journal.report.kind??(/^feat:/i.test(value.journal.report.title)?'feat':'bug')},
    targetId:value.journal.target.id,analysis:value.analysis,material:value.analysis?.material,hash:value.analysis?.hash,preflight:undefined,dirty:false,consent:false,automatic:false,error:'',preview:true});
  state.clientId=value.analysis?.clientId??state.clientId;state.projectRef=value.analysis?.projectRef??'';
  state.stage=value.journal.state==='published'?'submitted':value.journal.reviewReady||locked()?'review':'edit';
  if(['prepared','preparing','starting','running','blocked'].includes(value.analysis?.state)){
    state.material=value.analysis.material;state.hash=value.analysis.hash;state.stage=value.analysis.state==='prepared'?'scope':'analyzing';
    if(state.stage==='analyzing')analysisTimer=setTimeout(refreshAnalysis,1500);
  }else if(value.analysis?.state==='ready'&&!locked()){
    const matches=value.analysis.journalDigest===value.journal.digest;
    if(matches){state.report.title=value.analysis.title;state.report.body=value.analysis.body;await saveReview(false);}
  }
  if(state.stage==='review'&&!locked())await checkRoute();
  if(['failed','interrupted'].includes(value.analysis?.state))state.error=value.analysis.error;
}
function locked() { return ['writing', 'unknown', 'published', 'upload_failed'].includes(state.journal?.state); }
function issueMayExist() { return ['writing', 'unknown'].includes(state.journal?.state); }
function check(label, key) {
  return el('label', { className: 'check' }, [el('input', { type: 'checkbox', checked: state[key], disabled: state.busy, 'data-consent': key,
    onChange: event => { state[key] = event.target.checked; render(); } }), el('span', { text: label })]);
}
function pictureCards() {
  return el('div', { className: 'pictures' }, state.report.attachments.map((picture, index) => el('div', { className: 'picture' }, [
    el('img', { src: `data:${picture.mime};base64,${picture.base64}`, alt: `截图 ${index + 1}` }),
    el('div', {}, [...(state.stage==='edit'?[]:[button('复制图片', async () => { await copyImage(picture); state.error = '图片已复制，可粘贴到 Issue 页面'; }, 'text'),
      el('a', { text: '下载发送副本', href: `data:${picture.mime};base64,${picture.base64}`, download: picture.name, title: '已去除元数据的 PNG；这是自动提交的实际图片' }),
      ...(picture.original ? [el('a', { text: '下载原图', href: `data:${picture.original.mime};base64,${picture.original.base64}`, download: picture.original.name, title: '原图可能包含隐私元数据，自动提交不会上传原图' })] : [])]),
      ...(!locked() ? [button('移除', async () => { state.report.attachments.splice(index, 1); invalidate(); }, 'text')] : [])]),
  ])));
}
async function addFiles(files) {
  for (const file of files) {
    if (state.report.attachments.length >= 4 || file.size > 4000000 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('最多 4 张 PNG/JPEG/WebP，单张不超过 4 MB');
    state.report.attachments.push(await normalizePicture(file, state.report.attachments.length));
  }
  invalidate();
}
async function saveReview(checkTarget = true) {
  await flushDraft();
  const saved = await recordCall({ op: 'save', targetId: state.targetId, revision: state.revision, report: state.report });
  Object.assign(state, saved, { report: saved.journal.report, dirty: false, consent: false, stage: 'review' });
  state.automatic = false;
  if (checkTarget) await checkRoute();
}
async function checkRoute() {
  state.automatic=false;
  try {
    const preflight = await recordCall({ op: 'preflight', digest: state.journal.digest });
    state.preflight = preflight;
    state.automatic = !state.report.attachments.length || preflight.attachments;
    if (!state.automatic) state.error = '自动附件通路未配置。可复制图片或下载原图，然后手动创建 Issue。';
  } catch (error) { state.error = error.message + '。手动创建仍可使用。'; }
}
async function prepareAnalysis() {
  analysisEpoch++; clearTimeout(analysisTimer);
  // Persist the form first so a failed/cancelled client cannot lose the draft.
  await saveReview(false); state.error = '';
  const prepared = await recordCall({ op: 'prepare-analysis', report: state.report, logs: state.report.kind!=='feat', projectRef: state.projectRef, clientId:state.clientId, journalDigest:state.journal.digest });
  Object.assign(state, prepared, { stage: 'scope' });
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
  if (!state.consent || state.dirty) throw new Error('请先更新报告，并检查完整内容和图片');
  state.stage = 'submitting'; render();
  try {
    if (state.journal.state === 'draft') Object.assign(state, await recordCall({ op: 'approve', digest: state.journal.digest, confirmed: true }));
    Object.assign(state, await recordCall({ op: 'submit', digest: state.journal.digest }));
    state.stage = state.journal.state === 'published' ? 'submitted' : 'review';
  } catch (error) { state.stage = 'review'; throw error; }
}
async function run(action) {
  if (state.busy) return;
  state.busy = true; state.error = ''; render();
  try { await action(); } catch (error) { state.error = error.message || '操作未完成，草稿已保留'; }
  finally { state.busy = false; render(); }
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
      state.busy = true; state.stage = 'review'; render();
      try { await saveReview(); } finally { state.busy = false; render(); }
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
function render() {
  const scroll = app.dataset.stage === state.stage ? app.querySelector('.content')?.scrollTop ?? 0 : 0;
  const stageIndex = state.stage === 'edit' ? 0 : ['scope', 'analyzing'].includes(state.stage) ? 1 : ['review', 'submitting'].includes(state.stage) ? 2 : 3;
  const header = el('header', {}, [el('div',{className:'feedback-nav'},[button('新建反馈',startNew,state.stage==='edit'&&!state.journal?'primary':'secondary'),button('反馈记录',showHistory,state.stage==='history'?'primary':'secondary'),el('span',{className:'hint',text:state.items.length?`${state.items.filter(item=>!['published','retained'].includes(item.status)).length} 条待处理`:''})]),el('h1', { text: '感谢你的反馈，一起共建项目' }), note(state.stage==='history'?'查看每条反馈的分析与投递进度。':'简单描述，详细报告交给 Agent。'),
    el('nav', { 'aria-label': '反馈流程',hidden:state.stage==='history' }, ['填写问题', '分析与脱敏', '检查与提交', '完成'].map((text, index) => el('span', { text: `${index + 1}  ${text}`, className: index <= stageIndex ? 'current' : '', 'aria-current': index === stageIndex ? 'step' : 'false' })))]);
  const content = el('section', { className: 'content' }); const footer = el('footer');
  if (state.stage === 'history') {
    content.append(feedbackHistory(state.items,id=>run(()=>openRecord(id))));
    footer.append(button('刷新记录',showHistory),button('新建反馈',startNew,'primary'));
  } else if (state.stage === 'edit') {
    content.append(...feedbackForm(state,{input,note,button,pictureCards,addFiles,invalidate,run,render}));
    footer.append(el('span',{'data-save-status':'',className:'hint',text:state.journal&&!state.dirty?'草稿已保存到反馈记录':hasDraft()?'尚未保存，关闭前请保存':''}),button('保存草稿',flushDraft,'text'),button('直接反馈',saveReview),button('生成分析报告',prepareAnalysis,'primary',!state.clients.length));
    if(state.analysis?.state==='ready')footer.append(button('查看本条分析报告',async()=>{state.report.title=state.analysis.title;state.report.body=state.analysis.body;await saveReview();},'text'));
  } else if (['scope', 'analyzing'].includes(state.stage)) {
    const client = state.clients.find(c=>c.id===state.clientId);
    content.append(el('div', { className: 'notice', text: `分析成员：${client?.label ?? '已选成员'} · ${client?.model ?? ''}。${state.report.kind === 'feat' ? '版本和功能建议' : '版本、问题描述及近期错误线索'}先在本地脱敏，再交给该成员分析；如其模型在云端，脱敏材料会发送到该模型。截图不交给模型。` }),
      note('仅生成报告，不执行修复或创建 Issue。完成后会再次脱敏，并展示完整标题和正文供你检查。'),
      el('details',{},[el('summary',{text:'查看将发送的脱敏材料'}),el('textarea', { className: 'material', value: state.material, readOnly: true, 'aria-label': '脱敏分析材料' })]));
    if (state.stage === 'analyzing') content.append(el('div',{className:'analysis-progress',role:'status','aria-live':'polite'},[
      el('p',{'data-analysis-progress':'',text:state.analysis?.progress ?? '请求已发送，等待 Agent 开始分析'}),
      el('p',{'data-analysis-elapsed':'',className:'hint',text:'完成后会自动展示报告，可关闭面板稍后回来。'})]));
    if (state.analysis?.threadUrl) content.append(el('a', { href: state.analysis.threadUrl, text: '打开分析对话', target: '_blank', rel: 'noopener noreferrer' }));
    if (['blocked', 'preparing'].includes(state.analysis?.state)) content.append(note(state.analysis.error || 'Client 需要处理，请打开分析对话。', 'notice'));
    if (state.stage === 'analyzing') footer.append(button('停止等待，保留草稿', async () => { analysisEpoch++; clearTimeout(analysisTimer); const result = await recordCall({ op: 'cancel-analysis' }); state.analysis = result.analysis; state.stage = 'scope'; state.error = '已停止等待；这不会强制终止 Client，可打开分析对话查看。'; }));
    else footer.append(button('跳过分析', saveReview), ['failed', 'cancelled', 'interrupted'].includes(state.analysis?.state)
      ? button('重新准备材料', prepareAnalysis, 'primary') : button('开始分析', analyze, 'primary', !state.clientId));
  } else if (['review', 'handoff', 'submitting'].includes(state.stage)) {
    content.append(input('Issue 标题', 'title', false, true), input('报告正文', 'body', true, true), pictureCards(),
      el('div', { className: 'notice', text: `目标：${state.journal?.target.label ?? ''} · ${state.journal?.target.visibility === 'public' ? '公开可见' : '请核对目标权限'}。文本已经本地过滤，但仍需检查业务内容和截图。` }));
    if (state.stage === 'handoff') content.append(note('已打开手动创建入口。Issue 尚未提交：请粘贴标题、报告和图片，或下载图片后拖入目标网页。', 'notice'));
    if (state.journal?.state === 'upload_failed') content.append(note(state.journal.safeError, 'notice'));
    else if (issueMayExist()) content.append(note('提交结果待核对；不要再次手动创建，以免重复。此处仅核对，不会重发。', 'notice'));
    if (state.journal?.issue && issueMayExist()) content.append(el('a', { className: 'issue', text: `已创建，待核验：${state.journal.issue.url}`, href: state.journal.issue.url, target: '_blank', rel: 'noopener noreferrer' }));
    if (!issueMayExist()) content.append(check('我已检查完整报告和所有图片，并同意向上述目标提交', 'consent'));
    if (!locked()) footer.append(button('返回修改', async () => { state.stage = 'edit'; state.consent = false; }, 'text'), button('更新报告并检查通路', saveReview));
    const manual = el('a', { text: '手动创建', className: 'secondary', href: state.journal?.target.issueCreateUrl, target: '_blank', rel: 'noopener noreferrer',
      title: '跳转到 Issue 页面，然后进行手动粘贴问题并创建', 'data-publish': 'manual', 'aria-disabled': !state.consent || state.dirty || issueMayExist(),
      onClick: event => { if (!state.consent || state.dirty || issueMayExist() || state.busy) { event.preventDefault(); return; } void run(async()=>{Object.assign(state,await recordCall({op:'manual',digest:state.journal.digest}));state.stage='handoff';}); } });
    footer.append(manual);
    if (state.journal?.state === 'upload_failed') footer.append(button('保留回执，返回编辑', async () => { Object.assign(state, await recordCall({ op: 'reset-upload', digest: state.journal.digest, confirmed: true })); state.feedbackId=state.journal.id;state.analysis=undefined;state.stage = 'edit'; state.consent = false; state.dirty = false; }, 'primary'));
    else if (locked()) footer.append(button('核对提交结果', async () => { const value = await recordCall({ op: 'reconcile', digest: state.journal.digest }); Object.assign(state, value); state.error = value.message ?? ''; if (value.journal.state === 'published') state.stage = 'submitted'; }, 'primary'));
    else {
      const auto = button('确认上传', submit, 'primary', !state.consent || state.dirty || !state.automatic); auto.dataset.publish = 'auto'; footer.append(auto);
    }
    footer.append(note(state.stage === 'submitting' ? '正在上传，请等待回执；关闭后仍可重新打开核对状态。' : '自动提交优先；手动创建为兜底。复制按钮紧邻对应字段，图片可逐张复制或下载。'));
  } else if (state.stage === 'submitted') {
    content.append(el('div', { className: 'success' }, [el('h2', { text: '✓ 反馈已提交，感谢你的帮助' }), note('已回读远端 Issue，标题与报告正文核对通过。'),
      el('a', { className: 'issue', text: state.journal.issue.url, href: state.journal.issue.url, target: '_blank', rel: 'noopener noreferrer' }),
      el('a', { className: 'primary', text: '打开 Issue', href: state.journal.issue.url, target: '_blank', rel: 'noopener noreferrer' })]));
    footer.append(button('继续反馈', startNew), button('完成', () => bridge('close'), 'primary'));
  }
  if (state.error) content.append(el('p', { role: 'alert', className: 'error', text: state.error }));
  app.replaceChildren(header, content, footer);
  app.dataset.stage = state.stage; content.scrollTop = scroll;
}
render();
run(async()=>{
  const initial=await call({op:'bootstrap'});state.targets=initial.targets;state.clients=initial.clients??[];state.items=initial.items??[];
  state.clientId=state.clients[0]?.id??'';state.targetId=state.targets[0]?.id??'';
});
