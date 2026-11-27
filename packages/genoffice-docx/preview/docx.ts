import { parseDocx, readSections } from '@genoffice/docx-engine';
import { getSchema } from '@tiptap/core';
import { DOMSerializer } from '@tiptap/pm/model';
import { docStyleCss } from '../../docs/src/renderer/doc-style-css';
import { blocksToPmDoc } from '../../docs/src/renderer/editor/convert';
import { editorExtensions } from '../../docs/src/renderer/editor/extensions';
import { setDocFontTable } from '../../docs/src/renderer/line-metrics';
import './docx.css';

export async function mountDocxPreview(stage: HTMLElement, bytes: ArrayBuffer): Promise<void> {
  const parsed = await parseDocx(new Uint8Array(bytes));
  setDocFontTable(parsed.fontTable);
  const schema = getSchema(editorExtensions);
  const doc = schema.nodeFromJSON(blocksToPmDoc(parsed.blocks, readSections(parsed)));
  const page = document.createElement('article');
  page.className = 'doc-page docx-preview-page';
  page.append(DOMSerializer.fromSchema(schema).serializeFragment(doc.content));
  for (const link of page.querySelectorAll('a[href]')) link.removeAttribute('href');
  const docStyle = document.createElement('style');
  docStyle.textContent = docStyleCss(parsed);
  stage.replaceChildren(docStyle, page);
  document.documentElement.dataset.previewFormat = 'docx';
}
