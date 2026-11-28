/**
 * Read-only XLSX text preview model.
 *
 * The extractor in `spreadsheet-extract` emits plain text: one `# SheetName`
 * heading per worksheet, one line per row, cells joined with a delimiter. This
 * module turns that text back into a renderable model so the preview surface can
 * show an actual table grid instead of a wall of delimited lines, without
 * re-implementing the extractor.
 *
 * Scope is deliberately narrow and the UI must say so: the extractor reads cell
 * text only. Cell styles, merged ranges, column widths, column/row headers and
 * number formats are not recovered, and dates stay as their raw serial values.
 */

/**
 * Separator the extractor joins cells with.
 *
 * Upstream GenOffice 0.8.1039 joins with `" | "` and does not escape it, so a
 * cell whose own text contains a pipe — `研发 | 运维` — splits into two columns
 * and the reader sees a table that does not exist. Any printable delimiter has
 * that failure mode; the fix is a delimiter cell text cannot contain.
 *
 * US (U+001F) is forbidden in XML 1.0 character data, so every value the
 * extractor can emit is guaranteed free of it. Row tags already rely on the same
 * guarantee for RS/US, so this introduces no new assumption about file content.
 */
export const CELL_SEPARATOR = '\u001f';

/**
 * Row-number tag the extractor prefixes onto every emitted row line.
 *
 * Excel omits `<row>` entirely for a fully empty row, so the emitted order is not
 * the workbook's row numbering. The extractor carries the declared `r` attribute
 * through so the preview can show the row a reader would actually find in Excel.
 *
 * RS (U+001E) / US (U+001F) are forbidden in XML 1.0 character data, so no cell
 * value can produce these delimiters — the tag cannot be forged by file content.
 */
export const ROW_TAG_OPEN = '\u001e';
export const ROW_TAG_CLOSE = '\u001f';

/** `[rs]12[us]cells…` → the declared row number, or undefined when untagged. */
const ROW_TAG = new RegExp(`^${ROW_TAG_OPEN}(\\d+)${ROW_TAG_CLOSE}`, 'u');

/** A `# ` prefixed heading line introduces one worksheet. */
const SHEET_HEADING = /^# (.*)$/u;

export interface SpreadsheetRow {
  /** The worksheet row number the package declares for this row. */
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
  /**
   * Blank cells with a non-blank neighbour on both sides in the same row.
   *
   * This is the shape a covered merged range leaves behind, and it is the only
   * blank the preview cannot explain: a trailing blank is visibly the end of the
   * data, but an interior one looks like a lost value. The renderer warns only
   * when this is non-zero so the warning keeps meaning something.
   */
  readonly interiorBlankCount: number;
}

export interface SpreadsheetTextModel {
  readonly sheets: readonly SpreadsheetSheet[];
  /** True when the workbook contained no `# Sheet` section at all. */
  readonly empty: boolean;
}

/**
 * Split one extractor row line into cells.
 *
 * The separator is US, which no cell value can carry (see `CELL_SEPARATOR`), so
 * `.split` is exact rather than a heuristic: a pipe inside cell text stays in
 * the cell where it belongs.
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
    // A row keeps the package's declared number when the extractor tagged it. An
    // untagged line (older extractor output, or a package that omitted `r`) falls
    // back to a running count so the gutter is never empty.
    let previous = 0;
    const rows: SpreadsheetRow[] = rawRows.map((line) => {
      const tag = ROW_TAG.exec(line);
      const number = tag ? Number(tag[1]) : previous + 1;
      previous = number;
      return {
        number,
        cells: splitRow(tag ? line.slice(tag[0].length) : line),
      };
    });
    const columnCount = rows.reduce((widest, row) => Math.max(widest, row.cells.length), 0);
    let blankCellCount = 0;
    let interiorBlankCount = 0;
    for (const row of rows) {
      for (const [column, cell] of row.cells.entries()) {
        if (cell !== '') continue;
        blankCellCount += 1;
        // Interior = a non-blank cell exists on both sides within this row.
        const before = row.cells.slice(0, column).some((value) => value !== '');
        const after = row.cells.slice(column + 1).some((value) => value !== '');
        if (before && after) interiorBlankCount += 1;
      }
    }
    sheets.push({ name: current.name, rows, columnCount, blankCellCount, interiorBlankCount });
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
