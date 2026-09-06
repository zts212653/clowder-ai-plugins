/** Browser-safe policy and generated types for the closed materializer boundary. */
import {
  DOCX_MATERIALIZATION_AUTHOR_PATTERN,
  DOCX_MATERIALIZATION_TEXT_PATTERN,
  type DocxMaterializationOperation,
} from './generated/contract.generated.js';

const text = new RegExp(DOCX_MATERIALIZATION_TEXT_PATTERN, 'u');
const author = new RegExp(DOCX_MATERIALIZATION_AUTHOR_PATTERN, 'u');

/** Defensive pre-parse worker check, derived from the same public schema as Host validation. */
export function hasLosslessDocxOperationText(operation: DocxMaterializationOperation): boolean {
  if (operation?.kind === 'inspect') return true;
  if (operation?.kind !== 'tracked-change' && operation?.kind !== 'comment') return false;
  const value = operation.kind === 'tracked-change' ? operation.replacement : operation.body;
  const attribution = operation.attribution;
  return typeof value === 'string' && text.test(value)
    && typeof attribution?.author === 'string' && author.test(attribution.author)
    && typeof attribution.timestamp === 'string' && author.test(attribution.timestamp);
}

export const DOCX_MATERIALIZATION_MAX_BYTES = 8 * 1024 * 1024;
export const DOCX_MATERIALIZATION_MAX_WIRE_BYTES = 12 * 1024 * 1024;
export type {
  DocxMaterializationAnchor,
  DocxMaterializationAttribution,
  DocxMaterializationOperation,
  DocxMaterializationRequest,
  DocxMaterializationResponse,
  DocxMaterializationResult,
} from './generated/contract.generated.js';
