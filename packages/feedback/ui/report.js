import { Lexer } from 'marked';

/** Tokenize Markdown, then create only text and a fixed set of DOM elements.
 * Model HTML and remote images never become executable markup or fetches. */
export function reportPreview(body, el) {
  const inline = tokens => tokens.map(token => {
    if (['strong', 'em', 'del'].includes(token.type)) return el(token.type, {}, inline(token.tokens));
    if (token.type === 'codespan') return el('code', {text:token.text});
    if (token.type === 'br') return el('br');
    if (token.type === 'link' && /^https?:\/\//i.test(token.href)) return el('a', {href:token.href,target:'_blank',rel:'noopener noreferrer'}, inline(token.tokens));
    if (token.type === 'text' && token.tokens) return el('span', {}, inline(token.tokens));
    return el('span', {text:token.type === 'html' ? token.raw : token.text ?? token.raw});
  });
  const blocks = tokens => tokens.flatMap(token => {
    if (token.type === 'space' || token.type === 'def') return [];
    if (token.type === 'heading') return [el(`h${Math.min(token.depth,4)}`, {}, inline(token.tokens))];
    if (token.type === 'code') return [el('pre', {}, [el('code',{text:token.text})])];
    if (token.type === 'hr') return [el('hr')];
    if (token.type === 'blockquote') return [el('blockquote', {}, blocks(token.tokens))];
    if (token.type === 'list') return [el(token.ordered ? 'ol' : 'ul', {}, token.items.map(item=>el('li',{},blocks(item.tokens))))];
    if (token.type === 'table') return [el('div',{className:'report-table'},[el('table',{},[
      el('thead',{},[el('tr',{},token.header.map(cell=>el('th',{},inline(cell.tokens))))]),
      el('tbody',{},token.rows.map(row=>el('tr',{},row.map(cell=>el('td',{},inline(cell.tokens))))))
    ])])];
    return [el('p', {}, token.tokens ? inline(token.tokens) : [el('span',{text:token.text ?? token.raw})])];
  });
  return el('article',{className:'report-preview','aria-label':'报告正文预览'},blocks(Lexer.lex(body)));
}

export function reportReader(body, el) {
  return el('div',{className:'review-reader'},[
    el('div',{className:'review-reading-page','data-report-reader':'',role:'region',tabIndex:0,
      'aria-label':'阅读报告正文','aria-describedby':'report-reading-progress'},[reportPreview(body,el)]),
    el('div',{className:'review-pagination',role:'group','aria-label':'报告翻页'},[
      el('button',{type:'button',className:'text','data-report-prev':'',text:'上一页'}),
      el('span',{id:'report-reading-progress',role:'status','aria-live':'polite'},[]),
      el('button',{type:'button',className:'text','data-report-next':'',text:'下一页'}),
    ]),
  ]);
}

export function bindReportReader(reader, position, remember) {
  const pager = reader.nextElementSibling;
  const previous = pager.querySelector('[data-report-prev]');
  const next = pager.querySelector('[data-report-next]');
  const label = pager.querySelector('[role="status"]');
  let lines = [];
  let initialized = false;
  const step = () => Math.max(1,reader.clientHeight-36);
  const limit = () => Math.max(0,reader.scrollHeight-reader.clientHeight);
  const sync = () => {
    if(!reader.clientHeight)return;
    const max = limit(), atEnd = reader.scrollTop+1>=max;
    const pages = 1+Math.ceil(max/step());
    const number = atEnd?pages:1+Math.floor((reader.scrollTop+1)/step());
    previous.disabled=reader.scrollTop<1;next.disabled=atEnd;
    const text = pages===1?'完整报告':`第 ${number} / ${pages} 页`;
    if(label.textContent!==text)label.textContent=text;
    const top=reader.scrollTop;
    const bottom=reader.scrollTop+reader.clientHeight;
    const head=lines.find(line=>line.top<top && line.bottom>top);
    const tail=lines.find(line=>line.top<bottom && line.bottom>bottom);
    reader.style.clipPath=head||tail?`inset(${head?Math.ceil(head.bottom-top):0}px 0 ${tail?Math.ceil(bottom-tail.top):0}px)`:'';
    remember(reader.scrollTop);
  };
  const measure = () => {
    if(!reader.clientHeight)return;
    if(!initialized){reader.scrollTop=position;initialized=true;}
    const origin=reader.getBoundingClientRect().top-reader.scrollTop;
    const walker=document.createTreeWalker(reader.firstElementChild,NodeFilter.SHOW_TEXT);
    const range=document.createRange();
    lines=[];
    while(walker.nextNode()){
      range.selectNodeContents(walker.currentNode);
      for(const {top,bottom,height} of range.getClientRects()){
        if(height>0)lines.push({top:top-origin,bottom:bottom-origin});
      }
    }
    lines.sort((left,right)=>left.top-right.top);
    sync();
  };
  const advance = delta => { reader.scrollTop = delta<0 && reader.scrollTop+1>=limit()
      ? Math.max(0,(Math.ceil(limit()/step())-1)*step()) : reader.scrollTop+delta*step();
    sync(); };
  previous.onclick=()=>advance(-1);
  next.onclick=()=>advance(1);
  reader.addEventListener('scroll',sync);
  reader.addEventListener('report-updated',measure);
  reader.addEventListener('keydown',event=>{
    if(event.target!==reader)return;
    if(event.key==='ArrowLeft'||event.key==='PageUp'){event.preventDefault();advance(-1);}
    if(event.key==='ArrowRight'||event.key==='PageDown'||event.key===' '){event.preventDefault();advance(1);}
    if(event.key==='Home'||event.key==='End'){event.preventDefault();reader.scrollTop=event.key==='Home'?0:limit();sync();}
  });
  const observer = new ResizeObserver(measure);
  observer.observe(reader);
  measure();
  return ()=>observer.disconnect();
}
