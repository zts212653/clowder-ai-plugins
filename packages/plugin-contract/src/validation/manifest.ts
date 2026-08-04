import { createRequire } from 'node:module';

import type { PluginManifest } from '../generated/contract.generated.js';

const require = createRequire(import.meta.url);
const Ajv2020: new (options: {
  readonly allErrors: boolean;
  readonly strict: boolean;
}) => AjvInstance = require('ajv/dist/2020');
const addFormats: (ajv: AjvInstance) => void = require('ajv-formats');
const manifestSchema = require('@clowder-ai/plugin-contract/schemas/manifest') as Record<
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
  compile(schema: Record<string, unknown>): AjvValidateFunction;
}

export interface ManifestValidationError {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly message: string;
}

export type ManifestValidationResult =
  | {
      readonly valid: true;
      readonly manifest: PluginManifest;
      readonly errors: readonly [];
    }
  | {
      readonly valid: false;
      readonly errors: readonly ManifestValidationError[];
    };

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateSchema = ajv.compile(manifestSchema);

/**
 * Validates an untrusted plugin manifest against the contract-owned schema.
 *
 * The schema is resolved through the package's public export so runtime users
 * and the conformance suite share one manifest definition and Ajv policy.
 */
export function validateManifest(value: unknown): ManifestValidationResult {
  if (validateSchema(value)) {
    return {
      valid: true,
      manifest: value as PluginManifest,
      errors: [],
    };
  }

  return {
    valid: false,
    errors: (validateSchema.errors ?? []).map((error) => ({
      instancePath: error.instancePath,
      schemaPath: error.schemaPath,
      keyword: error.keyword,
      message: error.message ?? 'manifest validation failed',
    })),
  };
}
