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
