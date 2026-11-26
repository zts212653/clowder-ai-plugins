import { el } from './bridge.js';

export function feedbackForm(state, {input,note,pictureCards,addFiles,invalidate,run,render,threadControl}) {
  const kind=state.report.kind ?? 'bug';
  const types=el('fieldset',{className:'feedback-types'},[el('legend',{text:'反馈类型'}),...[
    ['bug','问题反馈'],['feat','功能建议']
  ].map(([value,label])=>el('label',{},[el('input',{type:'radio',name:'feedback-kind',value,checked:kind===value,disabled:state.busy,
    onChange:()=>{state.report.kind=value;state.report.title=`${value}: ${state.report.title.replace(/^(?:bug|feat):\s*/i,'')}`;invalidate();render();}}),el('span',{text:label})]))]);
  return [types,input('描述','body',true),el('div',{className:'attachments'},[
    el('div',{className:'attachment-tools'},[
      el('label',{className:'secondary add-picture',text:'＋ 添加图片'},[el('input',{'aria-label':'添加图片',type:'file',accept:'image/png,image/jpeg,image/webp',multiple:true,disabled:state.busy,onChange:event=>run(()=>addFiles(event.target.files))})]),
      threadControl,
      note('可粘贴截图，也可选择本地图片。')]),pictureCards(),note('请勿填写密码或令牌；截图不会交给模型。')])];
}

export function analysisSettings(state, {invalidate,note,clients}) {
  const updateContext=(field,value)=>{
    if(state[field]===value)return;
    state[field]=value;
    if(state.analysis){state.analysis=undefined;state.material=undefined;state.hash=undefined;state.contextChanged=true;}
    invalidate();
  };
  const member=el('select',{id:'analysis-member','aria-label':'分析成员',disabled:state.busy,onChange:event=>updateContext('clientId',event.target.value)},
    clients.map(value=>el('option',{value:value.id,text:`${value.label} · ${value.model}`})));
  member.value=state.clientId;
  return el('div',{className:'analysis-settings'},[
    el('h2',{text:'由谁来分析？'}),note(state.linkedThread
      ? `将在「${state.linkedThread.title || '未命名会话'}」继续分析，并使用该会话的项目。`
      : '选好分析成员和项目，再检查将发送的脱敏材料。'),
    el('label',{className:'field'},[el('span',{className:'label',text:'分析成员'}),member]),
    ...(!state.linkedThread?[el('label',{className:'field'},[el('span',{className:'label',text:'相关项目目录（可选）'}),
      el('input',{'aria-label':'相关项目目录',type:'text',value:state.projectRef,maxLength:4096,placeholder:'留空使用当前实例的项目',disabled:state.busy,onInput:event=>updateContext('projectRef',event.target.value)})])]:[])]);
}
