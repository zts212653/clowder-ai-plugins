/**
 * End-to-end regression for the XLSX preview extraction path.
 *
 * Builds a real OOXML workbook in memory (same approach as the upstream GenOffice
 * fixture builder) and runs it through the actual extractor and model, so the
 * behaviours the preview promises are pinned against a real package rather than
 * a hand-written extractor string.
 *
 * Run from the GenOffice build tree, which provides jszip:
 *   node --import tsx --test preview/xlsx-extraction.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import JSZip from 'jszip';

import { xlsxToText } from './spreadsheet-extract.js';
import { parseSpreadsheetText } from './spreadsheet-text.js';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`;

const PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

async function buildWorkbook(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', PACKAGE_RELS);
  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="员工名单" sheetId="1" r:id="rId1"/>
    <sheet name="费用 Budget" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`,
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`,
  );
  // 0 姓名, 1 部门, 2 分机, 3 rich-text 张三, 4 研发, 5 李四
  zip.file(
    'xl/sharedStrings.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="6" uniqueCount="6">
  <si><t>姓名</t></si>
  <si><t>部门</t></si>
  <si><t>分机</t></si>
  <si><r><t>张</t></r><r><t>三</t></r></si>
  <si><t>研发</t></si>
  <si><t>李四</t></si>
</sst>`,
  );
  // Row numbers are deliberately non-contiguous: Excel writes no <row> for a fully
  // empty row, so the package jumps 2 -> 5 -> 9. A preview that renumbers sequentially
  // would tell the reader to look at the wrong Excel row.
  // Row 2 keeps "02139" as an inline string (leading zero must survive).
  // Row 5 skips column B entirely -> the middle cell must come back empty.
  zip.file(
    'xl/worksheets/sheet1.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="2">
      <c r="A2" t="s"><v>0</v></c>
      <c r="B2" t="s"><v>1</v></c>
      <c r="C2" t="s"><v>2</v></c>
    </row>
    <row r="5">
      <c r="A5" t="s"><v>3</v></c>
      <c r="B5" t="s"><v>4</v></c>
      <c r="C5" t="inlineStr"><is><t>02139</t></is></c>
    </row>
    <row r="9">
      <c r="A9" t="s"><v>5</v></c>
      <c r="C9" t="inlineStr"><is><t>01088</t></is></c>
    </row>
  </sheetData>
</worksheet>`,
  );
  zip.file(
    'xl/worksheets/sheet2.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="inlineStr"><is><t>项目</t></is></c>
      <c r="B1" t="inlineStr"><is><t>已批准</t></is></c>
    </row>
    <row r="3">
      <c r="A3" t="inlineStr"><is><t>差旅</t></is></c>
      <c r="B3" t="b"><v>1</v></c>
    </row>
  </sheetData>
</worksheet>`,
  );
  return new Uint8Array(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

/**
 * A workbook whose cell text contains the literal pipe sequence the preview used
 * to split on. A1 is one cell `研发 | 运维`; B1 is `完成`.
 */
async function buildPipeWorkbook(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', PACKAGE_RELS);
  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="职责" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`,
  );
  // 0 `研发 | 运维` — one shared string that itself contains " | ".
  zip.file(
    'xl/sharedStrings.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3">
  <si><t>研发 | 运维</t></si>
  <si><t>完成</t></si>
  <si><t>负责人 | 交接</t></si>
</sst>`,
  );
  zip.file(
    'xl/worksheets/sheet1.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="s"><v>1</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>2</v></c>
      <c r="B2" t="inlineStr"><is><t>。</t></is></c>
    </row>
  </sheetData>
</worksheet>`,
  );
  return new Uint8Array(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

test('extracts a real workbook through the bounded preview reader', async () => {
  const model = parseSpreadsheetText(await xlsxToText(await buildWorkbook()));

  assert.equal(model.empty, false);
  assert.deepEqual(
    model.sheets.map((sheet) => sheet.name),
    ['员工名单', '费用 Budget'],
  );

  const [staff, budget] = model.sheets;
  assert.deepEqual(staff?.rows[0]?.cells, ['姓名', '部门', '分机']);
  // Rich-text runs join into one cell; the inline string keeps its leading zero.
  assert.deepEqual(staff?.rows[1]?.cells, ['张三', '研发', '02139']);
  // Column B was absent in the XML, so the preview must show an empty middle cell.
  assert.deepEqual(staff?.rows[2]?.cells, ['李四', '', '01088']);
  assert.equal(staff?.blankCellCount, 1);

  assert.deepEqual(budget?.rows[1]?.cells, ['差旅', 'TRUE']);
});

test('a row Excel skipped keeps its package row number end to end', async () => {
  // Excel writes no <row> for a fully empty row, so a real package can jump
  // r=2 -> r=5. This runs the actual extractor and model, so it fails if the
  // extractor stops carrying the declared row number (the parser tests alone
  // cannot, because they build their own tagged strings).
  const model = parseSpreadsheetText(await xlsxToText(await buildWorkbook()));

  const staff = model.sheets[0];
  assert.deepEqual(staff?.rows.map((row) => row.number), [2, 5, 9]);
  // The number must reach the model without leaking into a cell.
  assert.deepEqual(staff?.rows[1]?.cells, ['张三', '研发', '02139']);
  // Column B was absent in the XML, so the preview must show an empty middle cell.
  assert.deepEqual(staff?.rows[2]?.cells, ['李四', '', '01088']);

  // Second sheet shares the same package-level numbering rule.
  assert.deepEqual(model.sheets[1]?.rows.map((row) => row.number), [1, 3]);
});

test('a real cell whose text contains " | " keeps its value and column boundary', async () => {
  // The user-visible failure this guards: A1 is a single cell `研发 | 运维` and
  // B1 is `完成`. With a printable `" | "` separator the extractor joined them
  // and the parser re-split a 2-cell row into three columns, so the preview
  // showed `研发`, `运维`, `完成` — a table the workbook never contained.
  const model = parseSpreadsheetText(await xlsxToText(await buildPipeWorkbook()));

  const [sheet] = model.sheets;
  assert.equal(sheet?.name, '职责');
  assert.equal(sheet?.columnCount, 2);
  assert.deepEqual(sheet?.rows[0]?.cells, ['研发 | 运维', '完成']);
  assert.deepEqual(sheet?.rows[1]?.cells, ['负责人 | 交接', '。']);
});

test('rejects a package with no workbook part', async () => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  const bytes = new Uint8Array(
    await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
  );
  await assert.rejects(() => xlsxToText(bytes), /missing xl\/workbook\.xml/u);
});

test('a sheet whose part is missing is skipped, not fatal', async () => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', PACKAGE_RELS);
  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Gone" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
  );
  const bytes = new Uint8Array(
    await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
  );
  const model = parseSpreadsheetText(await xlsxToText(bytes));
  // The extractor drops a sheet it cannot open; the preview then has nothing to
  // show and the surface reports the empty case rather than a blank table.
  assert.equal(model.empty, true);
});
