import { createRequire } from 'node:module';

import type {
  AppendInput,
  AppendResult,
  DeliverInput,
  DeliverResult,
  ReadInput,
  ReadResult,
  SendInput,
  SendResult,
  MessagingAckRequest,
  MessagingAckResult,
  SnapshotInput,
  SnapshotResult,
  SubscribeInput,
  SubscribeResult,
} from '../wire/row-shapes.js';
import { validateMessagingSemantics } from './messaging-semantic.js';

const require = createRequire(import.meta.url);
const Ajv2020: new (options: {
  readonly allErrors: boolean;
  readonly strict: boolean;
}) => AjvInstance = require('ajv/dist/2020');
const addFormats: (ajv: AjvInstance) => void = require('ajv-formats');
const messagingSchema = require('@clowder-ai/plugin-contract/schemas/messaging') as Record<
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
  getSchema(ref: string): AjvValidateFunction | undefined;
}

export interface MessagingRowValidationError {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly message: string;
}

export type MessagingRowValidationResult<Value> =
  | { readonly valid: true; readonly value: Value; readonly errors: readonly [] }
  | { readonly valid: false; readonly errors: readonly MessagingRowValidationError[] };

export const MESSAGING_ROW_METHODS = [
  'messaging.send',
  'messaging.appendElements',
  'messaging.subscribe',
  'messaging.read',
  'messaging.ack',
  'messaging.snapshot',
  'host.messaging.deliver',
] as const;

export type MessagingRowMethod = (typeof MESSAGING_ROW_METHODS)[number];

export interface MessagingRowInputByMethod {
  readonly 'messaging.send': SendInput;
  readonly 'messaging.appendElements': AppendInput;
  readonly 'messaging.subscribe': SubscribeInput;
  readonly 'messaging.read': ReadInput;
  readonly 'messaging.ack': MessagingAckRequest;
  readonly 'messaging.snapshot': SnapshotInput;
  readonly 'host.messaging.deliver': DeliverInput;
}

export interface MessagingRowResultByMethod {
  readonly 'messaging.send': SendResult;
  readonly 'messaging.appendElements': AppendResult;
  readonly 'messaging.subscribe': SubscribeResult;
  readonly 'messaging.read': ReadResult;
  readonly 'messaging.ack': MessagingAckResult;
  readonly 'messaging.snapshot': SnapshotResult;
  readonly 'host.messaging.deliver': DeliverResult;
}

interface ValidatorEntry {
  readonly definition: string;
  readonly validate: AjvValidateFunction;
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(messagingSchema, messagingSchema['$id'] as string);

function validator(definition: string): ValidatorEntry {
  const validate = ajv.getSchema(
    `${String(messagingSchema['$id'])}#/$defs/${definition}`,
  );
  if (!validate) throw new Error(`missing messaging schema definition: ${definition}`);
  return { definition, validate };
}

const INPUT_VALIDATORS: Readonly<Record<MessagingRowMethod, ValidatorEntry>> = {
  'messaging.send': validator('MessageDraft'),
  'messaging.appendElements': validator('AppendElementsRequest'),
  'messaging.subscribe': validator('M0CSubscribeInput'),
  'messaging.read': validator('M0CReadInput'),
  'messaging.ack': validator('M0CAckInput'),
  'messaging.snapshot': validator('M0CSnapshotInput'),
  'host.messaging.deliver': validator('M0CDeliverInput'),
};

const RESULT_VALIDATORS: Readonly<Record<MessagingRowMethod, ValidatorEntry>> = {
  'messaging.send': validator('SendReceipt'),
  'messaging.appendElements': validator('AppendReceipt'),
  'messaging.subscribe': validator('M0CSubscribeResult'),
  'messaging.read': validator('M0CReadResult'),
  'messaging.ack': validator('M0CAckResult'),
  'messaging.snapshot': validator('M0CSnapshotResult'),
  'host.messaging.deliver': validator('M0CDeliverResult'),
};

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

function errorsOf(validate: AjvValidateFunction): MessagingRowValidationError[] {
  return (validate.errors ?? []).map((error) => ({
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message ?? 'messaging row validation failed',
  }));
}

function invalid(
  instancePath: string,
  schemaPath: string,
  keyword: string,
  message: string,
): MessagingRowValidationResult<never> {
  return {
    valid: false,
    errors: [{ instancePath, schemaPath, keyword, message }],
  };
}

function validateWith<Value>(
  entry: ValidatorEntry,
  value: unknown,
): MessagingRowValidationResult<Value> {
  let jsonSafe = false;
  try {
    jsonSafe = isJsonScalarTree(value);
  } catch {
    jsonSafe = false;
  }
  if (!jsonSafe) {
    return invalid(
      '',
      `#/$defs/${entry.definition}`,
      'jsonScalarTree',
      'value must contain only finite JSON values and Unicode scalar strings without cycles',
    );
  }

  let structurallyValid = false;
  try {
    structurallyValid = entry.validate(value);
  } catch {
    structurallyValid = false;
  }
  if (!structurallyValid) {
    const errors = errorsOf(entry.validate);
    return errors.length > 0
      ? { valid: false, errors }
      : invalid('', `#/$defs/${entry.definition}`, 'schema', 'schema validation failed');
  }

  const semantic = validateMessagingSemantics(entry.definition, value);
  if (!semantic.valid) {
    return {
      valid: false,
      errors: semantic.errors.map((error) => ({
        instancePath: error.path,
        schemaPath: `#/$defs/${entry.definition}`,
        keyword: 'maxEncodedBytes',
        message: error.message,
      })),
    };
  }

  return { valid: true, value: value as Value, errors: [] };
}

export function validateMessagingRowInput<Method extends MessagingRowMethod>(
  method: Method,
  value: unknown,
): MessagingRowValidationResult<MessagingRowInputByMethod[Method]> {
  return validateWith(INPUT_VALIDATORS[method], value);
}

export function validateMessagingRowResult<Method extends MessagingRowMethod>(
  method: Method,
  value: unknown,
): MessagingRowValidationResult<MessagingRowResultByMethod[Method]> {
  const structural = validateWith<MessagingRowResultByMethod[Method]>(
    RESULT_VALIDATORS[method],
    value,
  );
  if (!structural.valid || method !== 'messaging.send') return structural;

  const receipt = structural.value as SendResult;
  if (receipt.messageHandle.token === receipt.messageId) {
    return invalid(
      '/messageHandle/token',
      '#/$defs/SendReceipt',
      'messageHandleIdentity',
      'messageHandle.token must not equal messageId',
    );
  }
  return structural;
}
