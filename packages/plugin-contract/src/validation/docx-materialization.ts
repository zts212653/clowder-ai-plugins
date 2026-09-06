import { createRequire } from 'node:module';
import type { DocxMaterializationRequest, DocxMaterializationResponse } from '../generated/contract.generated.js';
import { DOCX_MATERIALIZATION_MAX_BYTES, DOCX_MATERIALIZATION_MAX_WIRE_BYTES } from '../docx-materialization.js';
export { DOCX_MATERIALIZATION_MAX_BYTES, DOCX_MATERIALIZATION_MAX_WIRE_BYTES } from '../docx-materialization.js';

const require = createRequire(import.meta.url);
const schema = require('@clowder-ai/plugin-contract/schemas/docx-materialization') as Record<string, unknown>;
interface Validator { (value: unknown): boolean; }
interface AjvInstance {
  addSchema(schema: Record<string, unknown>): void;
  compile(schema: Record<string, unknown>): Validator;
}
const Ajv2020: new (options: Record<string, unknown>) => AjvInstance = require('ajv/dist/2020');
const addFormats: (ajv: AjvInstance) => void = require('ajv-formats');
const ajv = new Ajv2020({ strict: false, allErrors: false, ownProperties: true });
addFormats(ajv);
ajv.addSchema(schema);
const requestValidator = ajv.compile({ $ref: `${schema.$id}#/$defs/DocxMaterializationRequest` });
const responseValidator = ajv.compile({ $ref: `${schema.$id}#/$defs/DocxMaterializationResponse` });

function boundedJson(value: unknown): boolean {
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' && Buffer.byteLength(json) <= DOCX_MATERIALIZATION_MAX_WIRE_BYTES;
  } catch {
    return false;
  }
}

function canonicalBytes(value: string): boolean {
  const bytes = Buffer.from(value, 'base64');
  return bytes.length > 0 && bytes.length <= DOCX_MATERIALIZATION_MAX_BYTES && bytes.toString('base64') === value;
}

/** Validate at both Host boundaries; worker output is untrusted even for an admitted package. */
export function validateDocxMaterializationRequest(value: unknown): value is DocxMaterializationRequest {
  return boundedJson(value) && requestValidator(value) && canonicalBytes((value as DocxMaterializationRequest).bytesBase64);
}

export function validateDocxMaterializationResponse(value: unknown): value is DocxMaterializationResponse {
  if (!boundedJson(value) || !responseValidator(value)) return false;
  const result = (value as DocxMaterializationResponse).result;
  return result.kind !== 'document' || canonicalBytes(result.bytesBase64);
}
