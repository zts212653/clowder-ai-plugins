import { el } from './bridge.js';

const labels={draft:'草稿',preparing:'正在准备分析',prepared:'待开始分析',starting:'等待分析',running:'分析中',blocked:'分析需要处理',
  ready:'待投递',manual:'待网页提交',writing:'正在投递',unknown:'投递结果待核对',upload_failed:'附件上传中断',published:'已投递',
  failed:'分析失败',interrupted:'分析已中断',cancelled:'已停止等待',unavailable:'状态暂不可用',retained:'已保留旧回执'};
export function feedbackHistory(items,{open,copyUrl,deleteId,requestDelete,cancelDelete,confirmDelete,busy}) {
  if(!items.length) return el('div',{className:'history-empty'},[el('h2',{text:'还没有反馈记录'}),el('p',{text:'新建一条反馈后，草稿、分析和投递进度都会保存在这里。'})]);
  return el('div',{className:'history-list'},items.map(item=>el('article',{className:'history-item','data-feedback-id':item.id},[
    el('div',{className:'history-heading'},[el('h2',{text:item.title}),el('span',{className:`status status-${item.status}`,text:item.screenshotsPending==='verify'?'请核对截图':item.status==='ready'&&item.analyzed?'分析完成 · 待投递':labels[item.status]??'待查看'})]),
    el('p',{className:'hint',text:`${item.kind==='feat'?'功能建议':'问题反馈'} · ${item.updatedAt?new Date(item.updatedAt).toLocaleString('zh-CN'):'历史记录'}`}),
    deleteId===item.id && item.deleteRevision!==undefined
      ? el('div',{className:'history-actions history-delete-confirm',role:'group','aria-label':'确认删除草稿'},[
        el('span',{text:'删除此草稿？'}),
        el('button',{type:'button',className:'secondary',text:'取消',disabled:busy,'data-cancel-draft-delete':'',onClick:cancelDelete}),
        el('button',{type:'button',className:'secondary history-delete-confirm-button',text:'确认删除',disabled:busy,onClick:confirmDelete}),
      ])
      : el('div',{className:'history-actions'},[
        el('button',{type:'button',className:'secondary',text:item.status==='published'?'查看反馈':item.status==='draft'?'继续填写':item.status==='ready'||item.status==='manual'?'继续投递':item.status==='unknown'?'核对结果':'查看进度',disabled:busy,onClick:()=>open(item.id)}),
        ...(item.issueUrl?[el('button',{type:'button',className:'text',disabled:busy,text:item.issueId?`复制 Issue #${item.issueId} 链接`:'复制 Issue 链接',onClick:()=>copyUrl(item.issueUrl)})]:[]),
        ...(item.deleteRevision!==undefined?[el('button',{type:'button',className:'text history-delete',text:'删除草稿',disabled:busy,'data-delete-draft':'',onClick:()=>requestDelete(item)})]:[]),
      ]),
  ])));
}
