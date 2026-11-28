import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CELL_SEPARATOR,
  parseSpreadsheetText,
  ROW_TAG_CLOSE,
  ROW_TAG_OPEN,
} from './spreadsheet-text.js';

/** Build one extractor row line the way `xlsxToText` emits it. */
const tagged = (number: number, cells: string) => `${ROW_TAG_OPEN}${number}${ROW_TAG_CLOSE}${cells}`;
/** Join cells the way the extractor does. */
const cells = (...values: string[]) => values.join(CELL_SEPARATOR);

test('splits the extractor output into sheets and carries each declared row number', () => {
  const text = [
    '# 通讯录',
    tagged(1, cells('姓名', '部门', '分机')),
    tagged(2, cells('张三', '研发', '02139')),
    '',
    '# Budget',
    tagged(1, cells('项目', '金额')),
    tagged(2, cells('差旅', '1000')),
  ].join('\n');

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

test('a row Excel skipped keeps the package row number instead of a running count', () => {
  // Excel writes no <row> for a fully empty row, so the package jumps 1 -> 4.
  // A running count would label row 4 as "2" and send the reader to the wrong line.
  const model = parseSpreadsheetText(
    ['# S', tagged(1, cells('a', 'b')), tagged(4, cells('c', 'd')), tagged(5, cells('e', 'f'))].join('\n'),
  );
  assert.deepEqual(model.sheets[0]?.rows.map((row) => row.number), [1, 4, 5]);
  // The tag must not leak into cell text.
  assert.deepEqual(model.sheets[0]?.rows[1]?.cells, ['c', 'd']);
});

test('an untagged line falls back to a running count so the gutter is never empty', () => {
  // Older extractor output (and packages that omit r) carries no tag.
  const model = parseSpreadsheetText(['# S', cells('a', 'b'), cells('c', 'd')].join('\n'));
  assert.deepEqual(model.sheets[0]?.rows.map((row) => row.number), [1, 2]);
});

test('keeps leading zeros and trailing blank cells the extractor produced', () => {
  // The extractor preserves "02139" verbatim (no numeric coercion) and pads
  // skipped columns with empty cells; the preview must not normalise either.
  const model = parseSpreadsheetText(['# Sheet1', tagged(1, cells('02139', '', '42'))].join('\n'));
  assert.deepEqual(model.sheets[0]?.rows[0]?.cells, ['02139', '', '42']);
  assert.equal(model.sheets[0]?.blankCellCount, 1);
});

test('a cell whose own text contains a pipe stays one column', () => {
  // Regression for a real workbook: A1 is the single cell `研发 | 运维` and B1 is
  // `完成`. Joined with the old printable `" | "` separator these rendered as
  // three columns; the reader saw a table the file never had.
  const model = parseSpreadsheetText(
    ['# 计划', tagged(1, cells('研发 | 运维', '完成')), tagged(2, cells('|', '| |'))].join('\n'),
  );
  const rows = model.sheets[0]?.rows;
  assert.deepEqual(rows?.[0]?.cells, ['研发 | 运维', '完成']);
  assert.equal(model.sheets[0]?.columnCount, 2);
  // Pipe-only and pipe-dense values survive too: the delimiter is not a pipe.
  assert.deepEqual(rows?.[1]?.cells, ['|', '| |']);
});

test('only an interior blank counts as maybe-merged, a trailing blank does not', () => {
  // Interior blank: values on both sides — the shape a covered merged range leaves.
  const interior = parseSpreadsheetText(['# S', tagged(1, cells('a', '', 'c'))].join('\n'));
  assert.equal(interior.sheets[0]?.interiorBlankCount, 1);

  // Trailing blank: visibly the end of the data, so it must not raise the warning.
  const trailing = parseSpreadsheetText(['# S', tagged(1, cells('a', 'b', ''))].join('\n'));
  assert.equal(trailing.sheets[0]?.blankCellCount, 1);
  assert.equal(trailing.sheets[0]?.interiorBlankCount, 0);
});

test('a short row does not widen or crash the sheet', () => {
  const model = parseSpreadsheetText(
    ['# Sheet1', tagged(1, cells('a', 'b', 'c')), tagged(2, 'd')].join('\n'),
  );
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
  const model = parseSpreadsheetText(['# ', cells('x', 'y')].join('\n'));
  assert.equal(model.sheets.length, 1);
  assert.equal(model.sheets[0]?.name, '');
  assert.deepEqual(model.sheets[0]?.rows[0]?.cells, ['x', 'y']);
});
