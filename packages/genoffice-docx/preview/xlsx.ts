/**
 * Read-only XLSX text preview.
 *
 * Shows what the extractor actually recovers — sheet tabs, real row numbers and
 * a table grid — and states on screen what it does not recover (styles, merged
 * ranges, number formats) so the surface never implies it looks like Excel.
 */
import { parseSpreadsheetText, type SpreadsheetSheet } from './spreadsheet-text';
import { xlsxToText } from './spreadsheet-extract';
import './xlsx.css';

/** Cap on rendered cells; a wide workbook must not lock up the preview surface. */
const MAX_RENDERED_CELLS = 20_000;

function renderSheet(sheet: SpreadsheetSheet, notice: readonly string[]): HTMLElement {
  const section = document.createElement('section');
  section.className = 'xlsx-sheet';

  const caption = document.createElement('h2');
  caption.className = 'xlsx-sheet-name';
  caption.textContent = sheet.name || '(未命名工作表)';
  section.append(caption);

  if (sheet.rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'xlsx-sheet-empty';
    empty.textContent = '此工作表没有可显示的单元格文本。';
    section.append(empty);
    return section;
  }

  const table = document.createElement('table');
  table.className = 'xlsx-table';

  const body = document.createElement('tbody');
  let rendered = 0;
  let truncated = false;
  for (const row of sheet.rows) {
    if (rendered + sheet.columnCount > MAX_RENDERED_CELLS) {
      truncated = true;
      break;
    }
    rendered += sheet.columnCount;
    const tr = document.createElement('tr');
    const gutter = document.createElement('th');
    gutter.className = 'xlsx-row-number';
    gutter.scope = 'row';
    gutter.textContent = String(row.number);
    tr.append(gutter);
    for (let column = 0; column < sheet.columnCount; column += 1) {
      const td = document.createElement('td');
      // Empty string is a real state: the extractor found no text for this cell.
      td.textContent = row.cells[column] ?? '';
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(body);
  section.append(table);

  if (truncated) {
    const more = document.createElement('p');
    more.className = 'xlsx-sheet-truncated';
    more.textContent = `仅显示前 ${rendered.toLocaleString('zh-CN')} 个单元格；此工作表更大。`;
    section.append(more);
  }
  for (const line of notice) {
    const item = document.createElement('p');
    item.className = 'xlsx-sheet-notice';
    item.textContent = line;
    section.append(item);
  }
  return section;
}

export async function mountXlsxPreview(stage: HTMLElement, bytes: ArrayBuffer): Promise<void> {
  const text = await xlsxToText(new Uint8Array(bytes));
  const model = parseSpreadsheetText(text);

  if (model.empty) {
    throw new Error('xlsx workbook contains no readable worksheet');
  }

  const deck = document.createElement('div');
  deck.className = 'xlsx-deck';

  const banner = document.createElement('p');
  banner.className = 'xlsx-banner';
  banner.textContent =
    '只读文本预览：仅提取单元格文本。不还原样式、合并单元格、列宽行高与数字格式（日期显示为原始序列值）。原文件不会被修改。';
  deck.append(banner);

  for (const sheet of model.sheets) {
    const hasBlanks = sheet.blankCellCount > 0;
    deck.append(
      renderSheet(
        sheet,
        hasBlanks
          ? ['空白单元格可能是原文件中的空单元格，也可能是合并单元格被覆盖的部分——此预览不还原合并区域。']
          : [],
      ),
    );
  }

  stage.replaceChildren(deck);
  document.documentElement.dataset.previewFormat = 'xlsx';
}
