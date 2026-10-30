import { el } from './bridge.js';

export function feedbackForm(state, {input,note,pictureCards,addFiles,invalidate,run,render}) {
  const kind=state.report.kind ?? 'bug';
  const types=el('fieldset',{className:'feedback-types'},[el('legend',{text:'反馈类型'}),...[
    ['bug','问题反馈'],['feat','功能建议']
  ].map(([value,label])=>el('label',{},[el('input',{type:'radio',name:'feedback-kind',value,checked:kind===value,disabled:state.busy,
    onChange:()=>{state.report.kind=value;state.report.title=`${value}: ${state.report.title.replace(/^(?:bug|feat):\s*/i,'')}`;invalidate();render();}}),el('span',{text:label})]))]);
  const target=el('select',{'aria-label':'反馈目标',disabled:state.busy,onChange:event=>{state.targetId=event.target.value;invalidate();}},
    state.targets.map(value=>el('option',{value:value.id,text:`${value.label} · ${value.visibility==='public'?'公开':value.visibility==='private'?'私有':'可见性未知'}`})));
  target.value=state.targetId;
  const member=el('select',{id:'analysis-member','aria-label':'分析成员',disabled:state.busy,onChange:event=>{state.clientId=event.target.value;}},
    state.clients.map(value=>el('option',{value:value.id,text:`${value.label} · ${value.model}`})));
  member.value=state.clientId;
  const options=el('details',{className:'feedback-options'},[el('summary',{text:'分析与投递设置'}),
    el('label',{className:'field'},[el('span',{className:'label',text:'分析成员'}),member]),
    el('label',{className:'field'},[el('span',{className:'label',text:'反馈目标'}),target]),
    el('label',{className:'field'},[el('span',{className:'label',text:'相关项目目录（可选）'}),
      el('input',{'aria-label':'相关项目目录',type:'text',value:state.projectRef,placeholder:'留空使用当前实例的项目',disabled:state.busy,onInput:event=>{state.projectRef=event.target.value;}})])]);
  return [types,input('标题（选填）','title'),input('描述','body',true),
    el('label',{className:'secondary add-picture',text:'＋ 添加图片'},[el('input',{type:'file',accept:'image/png,image/jpeg,image/webp',multiple:true,hidden:true,disabled:state.busy,onChange:event=>run(()=>addFiles(event.target.files))})]),
    pictureCards(),note('请勿填写密码、令牌等敏感信息。'),options];
}
