import { createRequire } from 'node:module';

import type {
  EventsPublishInput,
  EventsPublishResult,
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

export const SIGNAL_PAYLOAD_MAX_ENCODED_BYTES = 65_536 as const;

export type SignalSchemaCatalog = Readonly<
  Record<string, Readonly<Record<string, unknown>>>
>;

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
const validatePublishInputSchema = validator('EventsPublishInput');
const validatePublishResultSchema = validator('EventsPublishResult');
const resolvedSchemaValidators = new WeakMap<object, AjvValidateFunction | null>();

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

function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, ancestors))
    : Object.values(value as Record<string, unknown>).every((item) =>
        isJsonValue(item, ancestors),
      );
  ancestors.delete(value);
  return valid;
}

export function validateSignalDeclaration(
  value: unknown,
): SignalValidationResult<SignalDeclaration> {
  return validateWith(validateDeclarationSchema, value);
}

export function validateEventsPublishInput(
  value: unknown,
): SignalValidationResult<EventsPublishInput> {
  const structural = validateWith<EventsPublishInput>(validatePublishInputSchema, value);
  if (!structural.valid) return structural;
  let validJsonValue = false;
  try {
    validJsonValue = isJsonValue(structural.value.payload);
  } catch {
    validJsonValue = false;
  }
  if (!validJsonValue) {
    return {
      valid: false,
      errors: [
        {
          instancePath: '/payload',
          schemaPath: '#/$defs/EventsPublishInput/properties/payload',
          keyword: 'jsonValue',
          message: 'payload must contain only finite JSON values without cycles',
        },
      ],
    };
  }
  let encodedPayloadBytes: number;
  try {
    encodedPayloadBytes = Buffer.byteLength(
      JSON.stringify(structural.value.payload),
      'utf8',
    );
  } catch {
    return {
      valid: false,
      errors: [
        {
          instancePath: '/payload',
          schemaPath: '#/$defs/EventsPublishInput/properties/payload',
          keyword: 'jsonValue',
          message: 'payload could not be safely serialized as JSON',
        },
      ],
    };
  }
  if (encodedPayloadBytes > SIGNAL_PAYLOAD_MAX_ENCODED_BYTES) {
    return {
      valid: false,
      errors: [
        {
          instancePath: '/payload',
          schemaPath: '#/x-clowder-payload-max-encoded-bytes',
          keyword: 'maxEncodedBytes',
          message: `payload exceeds ${SIGNAL_PAYLOAD_MAX_ENCODED_BYTES} encoded bytes`,
        },
      ],
    };
  }
  return structural;
}

/**
 * Cross-document admission: a structurally legal publish is still forbidden
 * unless its signalType appears in this plugin manifest's declared provides.
 */
export function validateDeclaredEventsPublishInput(
  declarations: readonly unknown[],
  signalSchemas: SignalSchemaCatalog,
  value: unknown,
): SignalValidationResult<EventsPublishInput> {
  const input = validateEventsPublishInput(value);
  if (!input.valid) return input;

  let matchingDeclaration: SignalDeclaration | undefined;
  for (const candidate of declarations) {
    const declaration = validateSignalDeclaration(candidate);
    if (!declaration.valid) {
      return {
        valid: false,
        errors: [
          {
            instancePath: '/signals/provides',
            schemaPath: '#/$defs/SignalContribution/properties/provides',
            keyword: 'signalDeclaration',
            message: 'declared signal metadata is invalid',
          },
        ],
      };
    }
    if (declaration.value.type === input.value.signalType) {
      matchingDeclaration = declaration.value;
    }
  }

  if (matchingDeclaration === undefined) {
    return {
      valid: false,
      errors: [
        {
          instancePath: '/signalType',
          schemaPath: '#/$defs/SignalContribution/properties/provides',
          keyword: 'declaredSignalType',
          message: 'signalType is not declared by the plugin manifest',
        },
      ],
    };
  }

  const resolvedSchema = signalSchemas[matchingDeclaration.schemaRef];
  if (
    typeof resolvedSchema !== 'object' ||
    resolvedSchema === null ||
    Array.isArray(resolvedSchema)
  ) {
    return {
      valid: false,
      errors: [
        {
          instancePath: '/signalType',
          schemaPath: matchingDeclaration.schemaRef,
          keyword: 'signalSchemaUnresolved',
          message: 'declared signal schema is not resolved from the installed package',
        },
      ],
    };
  }

  let validateResolved = resolvedSchemaValidators.get(resolvedSchema);
  if (validateResolved === undefined) {
    try {
      const schemaAjv = new Ajv2020({ allErrors: true, strict: false });
      addFormats(schemaAjv);
      validateResolved = schemaAjv.compile(resolvedSchema as Record<string, unknown>);
      resolvedSchemaValidators.set(resolvedSchema, validateResolved);
    } catch {
      resolvedSchemaValidators.set(resolvedSchema, null);
      validateResolved = null;
    }
  }
  if (validateResolved === null) {
    return {
      valid: false,
      errors: [
        {
          instancePath: '/signalType',
          schemaPath: matchingDeclaration.schemaRef,
          keyword: 'signalSchemaInvalid',
          message: 'declared signal schema could not be compiled safely',
        },
      ],
    };
  }

  const content = {
    payload: input.value.payload,
    source: input.value.source,
  };
  if (!validateResolved(content)) {
    return { valid: false, errors: errorsOf(validateResolved) };
  }
  return input;
}

export function validateEventsPublishResult(
  value: unknown,
): SignalValidationResult<EventsPublishResult> {
  return validateWith(validatePublishResultSchema, value);
}
