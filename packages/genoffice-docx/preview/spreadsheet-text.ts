/**
 * Read-only XLSX text preview model.
 *
 * The upstream `xlsxToText` extractor (GenOffice 0.8.1039 `file-parse`) emits
 * plain text: one `# SheetName` heading per worksheet, one line per row, cells
 * joined with `" | "`. This module turns that text back into a renderable model
 * so the preview surface can show an actual table grid instead of a wall of
 * pipe-delimited lines, without re-implementing the extractor.
 *
 * Scope is deliberately narrow and the UI must say so: the extractor reads cell
 * text only. Cell styles, merged ranges, column widths, column/row headers and
 * number formats are not recovered, and dates stay as their raw serial values.
 */

/** Separator the upstream extractor joins cells with. */
const CELL_SEPARATOR = ' | ';

/** A `# ` prefixed heading line introduces one worksheet. */
const SHEET_HEADING = /^# (.*)$/u;

export interface SpreadsheetRow {
  /** 1-based worksheet row number, so a reader can point at the real row. */
  readonly number: number;
  readonly cells: readonly string[];
}

export interface SpreadsheetSheet {
  readonly name: string;
  readonly rows: readonly SpreadsheetRow[];
  /** Widest row in the sheet; the renderer pads shorter rows to this width. */
  readonly columnCount: number;
  /** Cells whose text the extractor did not recover (blank inline value). */
  readonly blankCellCount: number;
}

export interface SpreadsheetTextModel {
  readonly sheets: readonly SpreadsheetSheet[];
  /** True when the workbook contained no `# Sheet` section at all. */
  readonly empty: boolean;
}

/**
 * Split one upstream row line into cells.
 *
 * The extractor joins with `" | "`, so a plain `.split(' | ')` mis-splits any
 * cell whose own text ends or begins with a pipe. The extractor does not escape
 * that, which means the boundary is genuinely ambiguous; splitting on the exact
 * separator is the closest faithful reading and keeps the common case correct.
 */
function splitRow(line: string): string[] {
  return line.split(CELL_SEPARATOR);
}

/**
 * Split the extractor output into sheets.
 *
 * Upstream joins sections with `"\n\n"`, so a blank line always sits between two
 * sheets. That blank line belongs to the separator, not to the preceding
 * worksheet, and must not be rendered as an empty row.
 */
export function parseSpreadsheetText(text: string): SpreadsheetTextModel {
  // A trailing newline is a terminator, not an extra empty row.
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();

  const sheets: SpreadsheetSheet[] = [];
  let current: { name: string; rawRows: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    // Drop the separator blank line that precedes the next sheet heading.
    const rawRows = current.rawRows.at(-1) === '' ? current.rawRows.slice(0, -1) : current.rawRows;
    const rows: SpreadsheetRow[] = rawRows.map((line, index) => ({
      number: index + 1,
      cells: splitRow(line),
    }));
    const columnCount = rows.reduce((widest, row) => Math.max(widest, row.cells.length), 0);
    let blankCellCount = 0;
    for (const row of rows) {
      for (const cell of row.cells) if (cell === '') blankCellCount += 1;
    }
    sheets.push({ name: current.name, rows, columnCount, blankCellCount });
  };

  for (const line of lines) {
    const heading = SHEET_HEADING.exec(line);
    if (heading) {
      flush();
      current = { name: heading[1] ?? '', rawRows: [] };
      continue;
    }
    // Content before any sheet heading cannot be attributed to a worksheet.
    if (!current) continue;
    current.rawRows.push(line);
  }
  flush();

  return { sheets, empty: sheets.length === 0 };
}
