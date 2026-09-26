import { createRequire } from 'node:module';

import type { ActionDef, OperationRows } from '../generated/contract.generated.js';

const require = createRequire(import.meta.url);
const Ajv2020: new (options: {
  readonly allErrors: boolean;
  readonly strict: boolean;
}) => AjvInstance = require('ajv/dist/2020');
const addFormats: (ajv: AjvInstance) => void = require('ajv-formats');
const manifestSchema = require('@clowder-ai/plugin-contract/schemas/manifest') as Record<string, unknown>;
const pluginMetadataSchema = require(
  '@clowder-ai/plugin-contract/schemas/plugin-metadata'
) as Record<string, unknown>;
const signalSchema = require('@clowder-ai/plugin-contract/schemas/signals') as Record<string, unknown>;

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
}

export interface OperationRowsValidationError {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly message: string;
}

export type OperationRowsValidationResult =
  | { readonly valid: true; readonly value: OperationRows; readonly errors: readonly [] }
  | { readonly valid: false; readonly errors: readonly OperationRowsValidationError[] };

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const schemaId = manifestSchema['$id'] as string;
ajv.addSchema(pluginMetadataSchema, pluginMetadataSchema['$id'] as string);
ajv.addSchema(signalSchema, signalSchema['$id'] as string);
ajv.addSchema(manifestSchema, schemaId);

const validateRowsShape: AjvValidateFunction = ajv.compile({
  $ref: `${schemaId}#/$defs/OperationRows`,
});

function hasOnlyUnicodeScalars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isJsonScalarTree(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return hasOnlyUnicodeScalars(value);
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;

  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  if (Object.getOwnPropertySymbols(value).length > 0) return false;

  ancestors.add(value);
  let valid = true;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index) || !isJsonScalarTree(value[index], ancestors)) {
        valid = false;
        break;
      }
    }
    if (valid) {
      valid = Object.keys(value).every((key) => /^(0|[1-9][0-9]*)$/.test(key));
    }
  } else {
    for (const [key, child] of Object.entries(value)) {
      if (!hasOnlyUnicodeScalars(key) || !isJsonScalarTree(child, ancestors)) {
        valid = false;
        break;
      }
    }
  }
  ancestors.delete(value);
  return valid;
}

function invalid(
  instancePath: string,
  schemaPath: string,
  keyword: string,
  message: string,
): OperationRowsValidationResult {
  return {
    valid: false,
    errors: [{ instancePath, schemaPath, keyword, message }],
  };
}

/**
 * Validates an `OperationActionResult` with `render: 'rows'` against the manifest's
 * row declarations of the same operation. Host fail-closed: an undeclared or
 * non-row action reference, a duplicate row key, or any schema violation makes the
 * whole result invalid.
 */
export function validateOperationRowsResult(
  operation: { readonly actions: readonly ActionDef[] },
  value: unknown,
): OperationRowsValidationResult {
  let jsonSafe = false;
  try {
    jsonSafe = isJsonScalarTree(value);
  } catch {
    jsonSafe = false;
  }
  if (!jsonSafe) {
    return invalid(
      '',
      '#/$defs/OperationRows',
      'jsonScalarTree',
      'value must contain only finite JSON values and Unicode scalar strings without cycles',
    );
  }

  let structurallyValid = false;
  try {
    structurallyValid = validateRowsShape(value);
  } catch {
    structurallyValid = false;
  }
  if (!structurallyValid) {
    const errors = (validateRowsShape.errors ?? []).map((error) => ({
      instancePath: error.instancePath,
      schemaPath: error.schemaPath,
      keyword: error.keyword,
      message: error.message ?? 'operation rows validation failed',
    }));
    return errors.length > 0
      ? { valid: false, errors }
      : invalid('', '#/$defs/OperationRows', 'schema', 'schema validation failed');
  }

  const rows = value as OperationRows;
  const rowActionIds = new Set(
    operation.actions.filter((action) => action.render === 'row').map((action) => action.id),
  );

  const seenKeys = new Set<string>();
  for (let rowIndex = 0; rowIndex < rows.rows.length; rowIndex += 1) {
    const row = rows.rows[rowIndex];
    if (seenKeys.has(row.key)) {
      return invalid(
        `/rows/${rowIndex}/key`,
        '#/$defs/OperationRow',
        'uniqueKeys',
        `row key must be unique within the result: ${row.key}`,
      );
    }
    seenKeys.add(row.key);

    const actions = row.actions ?? [];
    for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
      const reference = actions[actionIndex].action;
      if (!rowActionIds.has(reference)) {
        return invalid(
          `/rows/${rowIndex}/actions/${actionIndex}/action`,
          '#/$defs/OperationRowAction',
          'rowActionReference',
          `row action must reference an ActionDef with render 'row' declared in the same operation: ${reference}`,
        );
      }
    }
  }

  return { valid: true, value: rows, errors: [] };
}
