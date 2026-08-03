import { createRequire } from 'node:module';

import type {
  PhysicalLimbAction,
  PhysicalLimbCancel,
  PhysicalLimbObservation,
} from '@clowder-ai/plugin-contract';

const require = createRequire(import.meta.url);

interface AjvValidateFunction {
  (data: unknown): boolean;
}

interface AjvInstance {
  addSchema(schema: Record<string, unknown>): void;
  compile(schema: Record<string, unknown>): AjvValidateFunction;
}

const Ajv2020 = require('ajv/dist/2020') as new (options: {
  allErrors: boolean;
  strict: boolean;
}) => AjvInstance;
const addFormats = require('ajv-formats') as (ajv: AjvInstance) => void;
const physicalLimbSchema = require(
  '@clowder-ai/plugin-contract/schemas/physical-limb',
) as Record<string, unknown>;

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(physicalLimbSchema);

const validateObservation = ajv.compile({
  $ref: 'https://clowder-ai.dev/schemas/physical-limb/v0.1#/$defs/PhysicalLimbObservation',
});
const validateInstruction = ajv.compile({
  anyOf: [
    { $ref: 'https://clowder-ai.dev/schemas/physical-limb/v0.1#/$defs/PhysicalLimbAction' },
    { $ref: 'https://clowder-ai.dev/schemas/physical-limb/v0.1#/$defs/PhysicalLimbCancel' },
  ],
});

export function isPhysicalLimbObservation(
  value: unknown,
): value is PhysicalLimbObservation {
  return validateObservation(value);
}

export function isPhysicalLimbInstruction(
  value: unknown,
): value is PhysicalLimbAction | PhysicalLimbCancel {
  return validateInstruction(value);
}
