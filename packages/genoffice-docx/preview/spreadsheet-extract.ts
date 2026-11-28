/**
 * Bounded XLSX text extraction for the read-only preview surface.
 *
 * The cell-reading logic is the upstream GenOffice 0.8.1039 `file-parse`
 * extractor (`packages/file-parse/src/xlsx.ts`, frozen at v0.8.1039, sha256 in
 * `source-lock.json`). Its only difference from this copy is how zip entries are
 * opened: upstream calls `JSZip.file(path).async('text')` straight off
 * `JSZip.loadAsync(bytes)`, which has no size bound. A preview surface renders
 * whatever the user points at, so every read here goes through
 * `createPreviewEntryReader` and is charged against the shared preview budget.
 *
 * Keep the parsing semantics below byte-for-byte close to upstream: changing
 * them silently changes what the preview shows.
 */
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { createPreviewEntryReader, type PreviewZipEntry } from '../src/preview-archive';
import { CELL_SEPARATOR, ROW_TAG_CLOSE, ROW_TAG_OPEN } from './spreadsheet-text';

// Text fidelity: no trim (xml:space="preserve" runs carry the spaces between words),
// no numeric coercion of tag values (otherwise <t>02139</t> becomes a number and loses characters)
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: false,
  parseTagValue: false,
  // trimValues also governs attributes; nothing read here (r:id, Target, cell ref, sheet
  // name) carries meaningful edge whitespace, and an untrimmed Target builds the wrong zip
  // path, which silently drops the whole sheet
  attributeValueProcessor: (_name: string, value: string) => value.trim(),
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** unwrap a fast-xml-parser text node (plain value, or { '#text': ... } when it carried attributes) */
function textOf(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'object' && !Array.isArray(node)) {
    return textOf((node as Record<string, unknown>)['#text']);
  }
  return String(node);
}

/** shared string entry: <si><t>…</t></si> or rich-text runs <si><r><t>…</t></r>…</si> */
function sharedStringText(si: Record<string, unknown>): string {
  if (si['t'] !== undefined) return textOf(si['t']);
  return asArray(si['r'] as unknown)
    .map((run) => textOf((run as Record<string, unknown>)['t']))
    .join('');
}

/** "BC12" → zero-based column index 54 */
function columnIndex(cellRef: string): number {
  let index = 0;
  for (const ch of cellRef) {
    if (ch < 'A' || ch > 'Z') break;
    index = index * 26 + (ch.charCodeAt(0) - 64);
  }
  return index - 1;
}

interface Cell {
  '@_r'?: string;
  '@_t'?: string;
  v?: unknown;
  is?: Record<string, unknown>;
}

function cellText(cell: Cell, shared: string[]): string {
  const type = cell['@_t'] ?? '';
  if (type === 'inlineStr') return cell.is ? sharedStringText(cell.is) : '';
  // <v> is ST_Xstring so it reaches the caller verbatim; the two reads that need it as a
  // scalar handle their own whitespace (Number tolerates it, the boolean compare strips it)
  const value = textOf(cell.v);
  if (type === 's') return shared[Number(value)] ?? '';
  if (type === 'b') return value.trim() === '1' ? 'TRUE' : 'FALSE';
  return value;
}

/**
 * Extract sheet text from an xlsx: one `# SheetName` section per sheet, one line
 * per `<row>` the package actually contains, cells joined with US (U+001F).
 *
 * The delimiter must be a character no cell value can carry, otherwise a cell
 * whose text contains the delimiter splits into two columns and the preview
 * shows a table that does not exist. US is forbidden in XML 1.0 character data,
 * so no value read from the workbook can collide with it.
 *
 * Rows the package omits (Excel writes no `<row>` for a fully empty row) are not
 * represented, so the emitted order is not Excel's row numbering. Consumers that
 * show a gutter must number what they received, not claim the workbook's rows.
 *
 * JSZip's published typings expose neither `_data` nor `internalStream`, which is
 * what the bounded reader needs to decompress on its own terms. The cast below
 * is the boundary where the frozen JSZip implementation is asserted to match the
 * narrow structural shape `preview-archive` describes; the same assertion the
 * PPTX path makes by string-substitution at build time.
 */
export async function xlsxToText(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  // One reader, so every part read is charged against the same total budget.
  const reader = createPreviewEntryReader(zip.files as unknown as Record<string, PreviewZipEntry>);

  const workbookXml = await reader.readText('xl/workbook.xml');
  if (!workbookXml) throw new Error('Invalid xlsx: missing xl/workbook.xml');

  // Sheet order and names come from workbook.xml; r:id maps to the actual sheet path via the workbook rels
  const workbook = parser.parse(workbookXml) as Record<string, any>;
  const sheets = asArray(workbook.workbook?.sheets?.sheet) as Array<Record<string, unknown>>;

  const relsXml = await reader.readText('xl/_rels/workbook.xml.rels');
  const relTargets = new Map<string, string>();
  if (relsXml) {
    const rels = parser.parse(relsXml) as Record<string, any>;
    for (const rel of asArray(rels.Relationships?.Relationship) as Array<Record<string, unknown>>) {
      const target = String(rel['@_Target'] ?? '');
      relTargets.set(
        String(rel['@_Id'] ?? ''),
        target.startsWith('/') ? target.slice(1) : `xl/${target}`,
      );
    }
  }

  const shared: string[] = [];
  const sharedXml = await reader.readText('xl/sharedStrings.xml');
  if (sharedXml) {
    const sst = parser.parse(sharedXml) as Record<string, any>;
    for (const si of asArray(sst.sst?.si) as Array<Record<string, unknown>>) {
      shared.push(sharedStringText(si));
    }
  }

  const sections: string[] = [];
  for (const sheet of sheets) {
    const path = relTargets.get(String(sheet['@_r:id'] ?? ''));
    const sheetXml = path ? await reader.readText(path) : undefined;
    if (!sheetXml) continue;
    const worksheet = parser.parse(sheetXml) as Record<string, any>;
    const lines: string[] = [`# ${String(sheet['@_name'] ?? '')}`];
    for (const row of asArray(worksheet.worksheet?.sheetData?.row) as Array<
      Record<string, unknown>
    >) {
      const cells: string[] = [];
      for (const cell of asArray(row.c as Cell | Cell[])) {
        const text = cellText(cell, shared);
        const col = cell['@_r'] ? columnIndex(cell['@_r']) : cells.length;
        while (cells.length < col) cells.push('');
        cells[col] = text;
      }
      // Tag the line with the package's own row number. Excel writes no <row> for a
      // fully empty row, so the emitted order is not the row numbering; without this
      // tag the preview could only show a running count and would mislabel the row a
      // reader is looking at. RS/US cannot occur in XML 1.0 character data, so a cell
      // value can never imitate the tag.
      const declared = Number(row['@_r']);
      const tag = Number.isSafeInteger(declared) && declared > 0 ? `${ROW_TAG_OPEN}${declared}${ROW_TAG_CLOSE}` : '';
      lines.push(`${tag}${cells.join(CELL_SEPARATOR)}`);
    }
    sections.push(lines.join('\n'));
  }
  return sections.join('\n\n');
}
