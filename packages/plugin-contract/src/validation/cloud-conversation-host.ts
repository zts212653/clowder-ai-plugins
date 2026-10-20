import { createRequire } from 'node:module';

import type {
  CloudConversationAckInput,
  CloudConversationAckResult,
  CloudConversationAppendMessageInput,
  CloudConversationAppendMessageResult,
  CloudBridgeFailureDiagnosticV1,
  CloudConversationListInput,
  CloudConversationListResult,
} from '../generated/contract.generated.js';

export type {
  CloudBridgeDomFingerprintV1,
  CloudBridgeFailureDiagnosticV1,
} from '../generated/contract.generated.js';

const require = createRequire(import.meta.url);
const Ajv2020: new (options: { readonly allErrors: boolean; readonly strict: boolean }) => AjvInstance =
  require('ajv/dist/2020');
const addFormats: (ajv: AjvInstance) => void = require('ajv-formats');
const manifestSchema = require('@clowder-ai/plugin-contract/schemas/manifest') as Record<string, unknown>;
const messagingSchema = require('@clowder-ai/plugin-contract/schemas/messaging') as Record<string, unknown>;
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
ajv.addSchema(messagingSchema, messagingSchema['$id'] as string);
ajv.addSchema(manifestSchema, schemaId);

function definitionValidator(name: string): AjvValidateFunction {
  return ajv.compile({ $ref: `${schemaId}#/$defs/${name}` });
}

const validateAppendMessageInput = definitionValidator('CloudConversationAppendMessageInput');
const validateAppendMessageResult = definitionValidator('CloudConversationAppendMessageResult');
const validateListInput = definitionValidator('CloudConversationListInput');
const validateListResult = definitionValidator('CloudConversationListResult');
const validateAckInput = definitionValidator('CloudConversationAckInput');
const validateAckResult = definitionValidator('CloudConversationAckResult');
const validateFailureDiagnostic = definitionValidator('CloudBridgeFailureDiagnosticV1');

export function isCloudConversationAppendMessageInput(
  value: unknown,
): value is CloudConversationAppendMessageInput {
  return (
    validateAppendMessageInput(value) &&
    isCloudConversationTextBudget((value as CloudConversationAppendMessageInput).text)
  );
}

export function isCloudConversationAppendMessageResult(
  value: unknown,
): value is CloudConversationAppendMessageResult {
  if (!validateAppendMessageResult(value)) return false;
  const result = value as CloudConversationAppendMessageResult;
  return (
    result.status !== 'failed' ||
    result.diagnostic === undefined ||
    isCloudBridgeFailureDiagnosticV1(result.diagnostic)
  );
}

export function isCloudConversationListInput(value: unknown): value is CloudConversationListInput {
  return validateListInput(value);
}

export function isCloudConversationListResult(value: unknown): value is CloudConversationListResult {
  return (
    validateListResult(value) &&
    (value as CloudConversationListResult).returns.every((result) =>
      isCloudConversationTextBudget(result.content),
    )
  );
}

export function isCloudConversationAckInput(value: unknown): value is CloudConversationAckInput {
  return validateAckInput(value);
}

export function isCloudConversationAckResult(value: unknown): value is CloudConversationAckResult {
  if (!validateAckResult(value)) return false;
  const result = value as CloudConversationAckResult;
  return (
    result.status !== 'failed' ||
    result.diagnostic === undefined ||
    isCloudBridgeFailureDiagnosticV1(result.diagnostic)
  );
}

export const CLOUD_CONVERSATION_MAX_TEXT_BYTES = 128 * 1024;

const textEncoder = new TextEncoder();

/**
 * Text / content budget check that mirrors the native host protocol: the JSON
 * schema bounds character count (maxLength 131072), while this function bounds
 * the UTF-8 byte size (<= 128 KiB) and requires non-empty content after trim.
 * Both the Host and the package run this check.
 */
export function isCloudConversationTextBudget(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.trim().length === 0) return false;
  return textEncoder.encode(value).length <= CLOUD_CONVERSATION_MAX_TEXT_BYTES;
}

const MAX_DOM_CHILD_INDEX = 0xffff_ffff;

export function isCloudBridgeFailureDiagnosticV1(value: unknown): value is CloudBridgeFailureDiagnosticV1 {
  if (!validateFailureDiagnostic(value)) return false;
  const diagnostic = value as CloudBridgeFailureDiagnosticV1;
  const paths = [
    diagnostic.fingerprint.firstUnsupportedPath,
    ...diagnostic.fingerprint.nodes.map((node) => node.path),
  ];
  return paths.every(
    (path) =>
      path === undefined ||
      [...path.matchAll(/\[(\d+)\]/g)].every(
        (match) => Number(match[1]) <= MAX_DOM_CHILD_INDEX,
      ),
  );
}
