import { createRequire } from 'node:module';

import type {
  MediaSourceReadInput,
  MediaSourceReadResult,
  MediaSourceSettleInput,
} from '../generated/contract.generated.js';

const require = createRequire(import.meta.url);
const Ajv2020: new (options: { readonly allErrors: boolean; readonly strict: boolean }) => AjvInstance =
  require('ajv/dist/2020');
const addFormats: (ajv: AjvInstance) => void = require('ajv-formats');
const manifestSchema = require('@clowder-ai/plugin-contract/schemas/manifest') as Record<string, unknown>;
const pluginMetadataSchema = require(
  '@clowder-ai/plugin-contract/schemas/plugin-metadata'
) as Record<string, unknown>;
const signalSchema = require('@clowder-ai/plugin-contract/schemas/signals') as Record<string, unknown>;

interface AjvValidateFunction {
  (value: unknown): boolean;
}

interface AjvInstance {
  addSchema(schema: Record<string, unknown>, id?: string): void;
  compile(schema: Record<string, unknown>): AjvValidateFunction;
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const schemaId = manifestSchema['$id'] as string;
ajv.addSchema(pluginMetadataSchema, pluginMetadataSchema['$id'] as string);
ajv.addSchema(signalSchema, signalSchema['$id'] as string);
ajv.addSchema(manifestSchema, schemaId);

function definitionValidator(name: string): AjvValidateFunction {
  return ajv.compile({ $ref: `${schemaId}#/$defs/${name}` });
}

const validateReadInput = definitionValidator('MediaSourceReadInput');
const validateReadResult = definitionValidator('MediaSourceReadResult');
const validateSettleInput = definitionValidator('MediaSourceSettleInput');

export function isMediaSourceReadInput(value: unknown): value is MediaSourceReadInput {
  return validateReadInput(value);
}

export function isMediaSourceReadResult(value: unknown): value is MediaSourceReadResult {
  return validateReadResult(value);
}

export function isMediaSourceSettleInput(value: unknown): value is MediaSourceSettleInput {
  return validateSettleInput(value);
}
