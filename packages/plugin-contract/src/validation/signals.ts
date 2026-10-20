import { createRequire } from 'node:module';

import type {
  SignalDeclaration,
} from '../generated/contract.generated.js';

const require = createRequire(import.meta.url);
const Ajv2020: new (options: {
  readonly allErrors: boolean;
  readonly strict: boolean;
}) => AjvInstance = require('ajv/dist/2020');
const addFormats: (ajv: AjvInstance) => void = require('ajv-formats');
const signalSchema = require('@clowder-ai/plugin-contract/schemas/signals') as Record<
  string,
  unknown
>;

interface AjvErrorObject {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly message?: string;
}

interface AjvValidateFunction {
  (value: unknown): boolean;
  readonly errors?: readonly AjvErrorObject[] | null;
}

interface AjvInstance {
  addSchema(schema: Record<string, unknown>, id?: string): void;
  compile(schema: Record<string, unknown>): AjvValidateFunction;
  getSchema(ref: string): AjvValidateFunction | undefined;
}

export interface SignalValidationError {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly message: string;
}

export type SignalValidationResult<Value> =
  | { readonly valid: true; readonly value: Value; readonly errors: readonly [] }
  | { readonly valid: false; readonly errors: readonly SignalValidationError[] };

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(signalSchema, signalSchema['$id'] as string);

function validator(definition: string): AjvValidateFunction {
  const validate = ajv.getSchema(
    `${String(signalSchema['$id'])}#/$defs/${definition}`,
  );
  if (!validate) throw new Error(`missing signal schema definition: ${definition}`);
  return validate;
}

const validateDeclarationSchema = validator('SignalDeclaration');

function errorsOf(validate: AjvValidateFunction): SignalValidationError[] {
  return (validate.errors ?? []).map((error) => ({
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message ?? 'signal validation failed',
  }));
}

function validateWith<Value>(
  validate: AjvValidateFunction,
  value: unknown,
): SignalValidationResult<Value> {
  if (!validate(value)) return { valid: false, errors: errorsOf(validate) };
  return { valid: true, value: value as Value, errors: [] };
}

export function validateSignalDeclaration(
  value: unknown,
): SignalValidationResult<SignalDeclaration> {
  return validateWith(validateDeclarationSchema, value);
}
