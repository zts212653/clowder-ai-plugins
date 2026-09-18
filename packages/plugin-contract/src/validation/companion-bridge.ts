import type { CompanionCommand, CompanionEvent, CompanionReply } from '../generated/contract.generated.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const schema = require('@clowder-ai/plugin-contract/schemas/companion-bridge') as Record<string, unknown>;
interface Validator { (value: unknown): boolean; }
interface AjvInstance { addSchema(schema: Record<string, unknown>): void; compile(schema: Record<string, unknown>): Validator; }
const Ajv: new (options: Record<string, unknown>) => AjvInstance = require('ajv/dist/2020');
const formats: (ajv: AjvInstance) => void = require('ajv-formats');
const ajv = new Ajv({ strict: false, allErrors: false, ownProperties: true });
formats(ajv); ajv.addSchema(schema);
const command = ajv.compile({ $ref: `${schema.$id}#/$defs/CompanionCommand` });
const reply = ajv.compile({ $ref: `${schema.$id}#/$defs/CompanionReply` });
const event = ajv.compile({ $ref: `${schema.$id}#/$defs/CompanionEvent` });

function bounded(value: unknown): boolean {
  try { const json = JSON.stringify(value); return typeof json === 'string' && Buffer.byteLength(json) <= 1_500_000; }
  catch { return false; }
}
/** Structural validation never substitutes for a current Host lease or a user gesture. */
export function validateCompanionCommand(value: unknown): value is CompanionCommand {
  if (!bounded(value) || !command(value)) return false;
  const parsed = value as CompanionCommand;
  if (parsed.kind === 'text') return parsed.text.trim().length > 0;
  if (parsed.kind === 'screen.frame') return /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(parsed.frame.image);
  return true;
}
export function validateCompanionReply(value: unknown): value is CompanionReply {
  return bounded(value) && reply(value);
}
export function validateCompanionEvent(value: unknown): value is CompanionEvent { return bounded(value) && event(value); }
