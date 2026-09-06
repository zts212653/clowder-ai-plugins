import {
  DOCX_MATERIALIZATION_MAX_BYTES,
  hasLosslessDocxOperationText,
  type DocxMaterializationAnchor,
  type DocxMaterializationRequest,
  type DocxMaterializationResponse,
  type DocxMaterializationResult,
} from '@clowder-ai/plugin-contract/docx-materialization';
import { generateParagraphXml, parseDocx, saveDocx, type Block, type GeneratedBlock, type Run, type SaveBlock } from '@genoffice/docx-engine';
import JSZip from 'jszip';
import { usedWordIds } from './revision-ids.js';

const textBlockTypes = new Set(['paragraph', 'heading', 'listItem']);
const supportedInline = new Set(['w:p', 'w:r', 'w:t', 'w:tab', 'w:br', 'w:cr', 'w:ins', 'w:del', 'w:delText', 'w:commentRangeStart', 'w:commentRangeEnd', 'w:commentReference']);
const reject = (code: Extract<DocxMaterializationResult, { kind: 'rejected' }>['code']): DocxMaterializationResult => ({ kind: 'rejected', code });

function visibleText(block: Block): string {
  return (block.runs ?? []).filter(run => !run.del).map(run => run.text).join('');
}

/** Reject targets whose regenerated inline model cannot preserve their original structure. */
function editable(block: Block): block is Block & { type: GeneratedBlock['type']; docxIndex: number; originalXml: string; runs: Run[] } {
  if (!textBlockTypes.has(block.type) || block.docxIndex === null || !block.originalXml || !block.runs || block.hidden) return false;
  if (block.sdtShell || block.blockRevision || /<w:sectPr\b/.test(block.originalXml)) return false;
  const inline = block.originalXml.replace(/<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>/g, '').replace(/<w:rPr\b[^>]*>[\s\S]*?<\/w:rPr>/g, '').replace(/<w:[pr]Pr\b[^>]*\/>/g, '');
  return [...inline.matchAll(/<\/?([A-Za-z_][\w:.-]*)\b/g)].every(match => supportedInline.has(match[1] ?? ''));
}

async function anchor(block: Block): Promise<DocxMaterializationAnchor> {
  const textQuote = visibleText(block);
  const bytes = new TextEncoder().encode(`${textQuote}\0${block.originalXml ?? ''}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  return { paragraphId: `p:${block.docxIndex}:${hex}`, textQuote };
}

function encode(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  return btoa(binary);
}

function nextId(used: Set<string>): string {
  for (let id = 0; id < 65536; id++) if (!used.has(String(id))) return String(id);
  throw new Error('identifier budget exhausted');
}

/** ZIP timestamp normalization is packaging only; OOXML parsing and mutation stay in the same upstream engine. */
async function canonicalArchive(bytes: Uint8Array, timestamp: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);
  for (const entry of Object.values(zip.files)) entry.date = new Date(timestamp);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

async function compute(request: DocxMaterializationRequest): Promise<DocxMaterializationResult> {
  if (request.protocolVersion !== '1.0.0' || request.mediaType !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return reject('INVALID_REQUEST');
  if (!hasLosslessDocxOperationText(request.operation)) return reject('INVALID_REQUEST');
  if (typeof request.bytesBase64 !== 'string' || request.bytesBase64.length > Math.ceil(DOCX_MATERIALIZATION_MAX_BYTES / 3) * 4) return reject('LIMIT_EXCEEDED');
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(request.bytesBase64), char => char.charCodeAt(0)); } catch { return reject('INVALID_DOCX'); }
  if (bytes.length > DOCX_MATERIALIZATION_MAX_BYTES) return reject('LIMIT_EXCEEDED');
  let parsed: Awaited<ReturnType<typeof parseDocx>>;
  try { parsed = await parseDocx(bytes); } catch { return reject('INVALID_DOCX'); }
  if (parsed.blocks.length > 65535) return reject('LIMIT_EXCEEDED');
  const operation = request.operation;
  if (operation.kind === 'inspect') {
    if (!Number.isInteger(operation.cursor) || operation.cursor < 0 || !Number.isInteger(operation.limit) || operation.limit < 1 || operation.limit > 32) return reject('INVALID_REQUEST');
    const rows = parsed.blocks.filter(block => !block.hidden && block.docxIndex !== null && visibleText(block).length > 0 && visibleText(block).length <= 8192);
    const selected = rows.slice(operation.cursor, operation.cursor + operation.limit);
    const documentEditable = !parsed.protection?.enforced && !parsed.removePersonalInfo;
    const paragraphs = await Promise.all(selected.map(async block => ({ target: await anchor(block), editable: documentEditable && editable(block) })));
    const next = operation.cursor + selected.length;
    return { kind: 'inspection', paragraphs, nextCursor: next < rows.length ? next : null };
  }
  if (operation.kind !== 'tracked-change' && operation.kind !== 'comment') return reject('INVALID_REQUEST');
  const index = /^p:([0-9]+):[a-f0-9]{64}$/.exec(operation.target.paragraphId)?.[1];
  const candidates = parsed.blocks.filter(block => block.docxIndex === Number(index) && !block.hidden);
  if (index === undefined || candidates.length !== 1) return reject('TARGET_MISMATCH');
  const block = candidates[0];
  if (!block || (await anchor(block)).paragraphId !== operation.target.paragraphId || visibleText(block) !== operation.target.textQuote) return reject('TARGET_MISMATCH');
  if (!editable(block) || parsed.protection?.enforced || parsed.removePersonalInfo) return reject('UNSUPPORTED_TARGET');
  let runs: Run[];
  let comments = parsed.comments;
  if (operation.kind === 'tracked-change') {
    if (block.runs.some(run => run.ins || run.del) || operation.replacement.length > 8192) return reject('UNSUPPORTED_TARGET');
    const ids = usedWordIds(parsed.internal.documentXml);
    const deletionId = nextId(ids); ids.add(deletionId);
    const revision = { author: operation.attribution.author, date: operation.attribution.timestamp };
    const original = block.runs.map(run => ({ ...run, del: { ...revision, id: deletionId } }));
    const first = block.runs[0];
    runs = [...original, ...(operation.replacement ? [{ ...(first ?? { text: '' }), text: operation.replacement, ins: { ...revision, id: nextId(ids) } }] : [])];
  } else {
    if (!operation.body || operation.body.length > 8192) return reject('INVALID_REQUEST');
    const commentId = nextId(new Set(parsed.comments.map(comment => comment.id)));
    runs = block.runs.map(run => run.del ? { ...run } : { ...run, commentIds: [...(run.commentIds ?? []), commentId] });
    comments = [...parsed.comments, { id: commentId, author: operation.attribution.author, date: operation.attribution.timestamp, text: operation.body }];
  }
  const generated: GeneratedBlock = { ...block, runs };
  const xml = generateParagraphXml(generated, {
    headingStyleIds: parsed.headingStyleIds,
    ...(parsed.listParagraphStyleId ? { listParagraphStyleId: parsed.listParagraphStyleId } : {}),
    allocateHyperlinkRel: () => { throw new Error('unsupported hyperlink target'); },
  });
  // Preserve original paragraph attributes; all semantic OOXML comes from the engine.
  const opening = /^<w:p\b[^>]*>/.exec(block.originalXml)?.[0];
  if (!opening) return reject('UNSUPPORTED_TARGET');
  const updatedXml = xml.replace(/^<w:p>/, opening);
  const finalBlocks: SaveBlock[] = parsed.blocks.filter(row => !row.hidden).map(row => {
    if (row.docxIndex === block.docxIndex) return { kind: 'xml', docxIndex: block.docxIndex, xml: updatedXml };
    if (row.docxIndex === null) throw new Error('unanchored original block');
    return { kind: 'original', docxIndex: row.docxIndex };
  });
  const result = await saveDocx(parsed, finalBlocks, { savedAt: operation.attribution.timestamp, ...(operation.kind === 'comment' ? { comments } : {}) });
  const canonical = await canonicalArchive(result, operation.attribution.timestamp);
  if (canonical.length > DOCX_MATERIALIZATION_MAX_BYTES) return reject('LIMIT_EXCEEDED');
  return { kind: 'document', bytesBase64: encode(canonical) };
}

export async function materializeDocx(request: DocxMaterializationRequest): Promise<DocxMaterializationResponse> {
  let result: DocxMaterializationResult;
  try { result = await compute(request); } catch { result = reject('UNSUPPORTED_TARGET'); }
  return { protocolVersion: '1.0.0', requestId: request.requestId, result };
}
