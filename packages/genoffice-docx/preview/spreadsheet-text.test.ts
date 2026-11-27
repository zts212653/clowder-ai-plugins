import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSpreadsheetText } from './spreadsheet-text.js';
test('splits the extractor output into sheets and real row numbers', () => {
  const text = ['# 通讯录', '姓名 | 部门 | 分机', '张三 | 研发 | 02139', '', '# Budget', '项目 | 金额', '差旅 | 1000'].join('\n');

  const model = parseSpreadsheetText(text);
  assert.equal(model.empty, false);
  assert.equal(model.sheets.length, 2);

  const [contacts, budget] = model.sheets;
  assert.equal(contacts?.name, '通讯录');
  assert.equal(contacts?.columnCount, 3);
  assert.deepEqual(
    contacts?.rows.map((row) => ({ number: row.number, cells: row.cells })),
    [
      { number: 1, cells: ['姓名', '部门', '分机'] },
      { number: 2, cells: ['张三', '研发', '02139'] },
    ],
  );

  assert.equal(budget?.name, 'Budget');
  assert.equal(budget?.columnCount, 2);
  assert.equal(budget?.rows.length, 2);
});

test('keeps leading zeros and trailing blank cells the extractor produced', () => {
  // The extractor preserves "02139" verbatim (no numeric coercion) and pads
  // skipped columns with empty cells; the preview must not normalise either.
  const model = parseSpreadsheetText(['# Sheet1', '02139 |  | 42'].join('\n'));
  assert.deepEqual(model.sheets[0]?.rows[0]?.cells, ['02139', '', '42']);
  assert.equal(model.sheets[0]?.blankCellCount, 1);
});

test('a short row does not widen or crash the sheet', () => {
  const model = parseSpreadsheetText(['# Sheet1', 'a | b | c', 'd'].join('\n'));
  const sheet = model.sheets[0];
  assert.equal(sheet?.columnCount, 3);
  assert.deepEqual(sheet?.rows[1]?.cells, ['d']);
});

test('an empty worksheet keeps its heading and renders no rows', () => {
  const model = parseSpreadsheetText('# Empty');
  assert.equal(model.empty, false);
  assert.equal(model.sheets[0]?.name, 'Empty');
  assert.deepEqual(model.sheets[0]?.rows, []);
  assert.equal(model.sheets[0]?.columnCount, 0);
});

test('a workbook with no sheet heading is reported as empty', () => {
  assert.equal(parseSpreadsheetText('').empty, true);
  // Content before any heading cannot be attributed to a worksheet.
  assert.equal(parseSpreadsheetText('stray line').empty, true);
});

test('a trailing newline is a terminator, not an empty row', () => {
  const withNewline = parseSpreadsheetText('# S\nonly\n');
  const without = parseSpreadsheetText('# S\nonly');
  assert.deepEqual(withNewline, without);
  assert.equal(withNewline.sheets[0]?.rows.length, 1);
});

test('a header-less sheet name is kept as an empty name, not dropped', () => {
  const model = parseSpreadsheetText('# \nx | y');
  assert.equal(model.sheets.length, 1);
  assert.equal(model.sheets[0]?.name, '');
  assert.deepEqual(model.sheets[0]?.rows[0]?.cells, ['x', 'y']);
});
