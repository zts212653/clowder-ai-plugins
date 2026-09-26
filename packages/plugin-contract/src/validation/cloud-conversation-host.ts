import { createRequire } from 'node:module';

import type {
  CloudConversationAckInput,
  CloudConversationAckResult,
  CloudConversationAppendMessageInput,
  CloudConversationAppendMessageResult,
  CloudConversationListInput,
  CloudConversationListResult,
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

const validateAppendMessageInput = definitionValidator('CloudConversationAppendMessageInput');
const validateAppendMessageResult = definitionValidator('CloudConversationAppendMessageResult');
const validateListInput = definitionValidator('CloudConversationListInput');
const validateListResult = definitionValidator('CloudConversationListResult');
const validateAckInput = definitionValidator('CloudConversationAckInput');
const validateAckResult = definitionValidator('CloudConversationAckResult');

export function isCloudConversationAppendMessageInput(
  value: unknown,
): value is CloudConversationAppendMessageInput {
  return validateAppendMessageInput(value);
}

export function isCloudConversationAppendMessageResult(
  value: unknown,
): value is CloudConversationAppendMessageResult {
  return validateAppendMessageResult(value);
}

export function isCloudConversationListInput(value: unknown): value is CloudConversationListInput {
  return validateListInput(value);
}

export function isCloudConversationListResult(value: unknown): value is CloudConversationListResult {
  return validateListResult(value);
}

export function isCloudConversationAckInput(value: unknown): value is CloudConversationAckInput {
  return validateAckInput(value);
}

export function isCloudConversationAckResult(value: unknown): value is CloudConversationAckResult {
  return validateAckResult(value);
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

// --- CloudBridgeFailureDiagnosticV1 -----------------------------------------------------
// Ported field-by-field from the Host shared type
// (packages/shared/src/types/cloud-bridge-outbound-receipt.ts). The DOM fingerprint
// rules (path grammar, per-node field caps, DOM child index <= 0xffffffff) cannot be
// expressed in JSON schema, so this validator stays hand-written.

const DIAGNOSTIC_FIELDS = new Set(['v', 'errorCode', 'nextAction', 'fingerprint']);
const FINGERPRINT_FIELDS = new Set([
  'v',
  'phase',
  'adapterRevision',
  'artifactRevision',
  'firstUnsupportedPath',
  'nodes',
  'truncated',
]);
const FINGERPRINT_NODE_FIELDS = new Set([
  'path',
  'kind',
  'empty',
  'tag',
  'nodeType',
  'childCount',
  'contentEditable',
  'proseMirror',
  'placeholder',
  'virtualKeyboard',
  'trailingBreak',
]);
const FINGERPRINT_PATH =
  /^composer(?:\/(?:[a-z][a-z0-9-]{0,31}|#text|#node-(?:0|[1-9]\d{0,3}))\[(?:0|[1-9]\d{0,9})\])*$/;
const MAX_FINGERPRINT_PATH_LENGTH = 512;
const MAX_DOM_CHILD_INDEX = 0xffff_ffff;

export interface CloudBridgeDomFingerprintV1 {
  readonly v: 1;
  readonly phase: string;
  readonly adapterRevision: string;
  readonly artifactRevision: string;
  readonly firstUnsupportedPath?: string;
  readonly nodes: readonly Readonly<Record<string, string | number | boolean>>[];
  readonly truncated: boolean;
}

export interface CloudBridgeFailureDiagnosticV1 {
  readonly v: 1;
  readonly errorCode: string;
  readonly nextAction: 'inspect_bound_tab';
  readonly fingerprint: CloudBridgeDomFingerprintV1;
}

function isDiagnosticToken(value: unknown, maximum = 32): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

function isFingerprintPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_FINGERPRINT_PATH_LENGTH &&
    FINGERPRINT_PATH.test(value) &&
    [...value.matchAll(/\[(\d+)\]/g)].every((match) => Number(match[1]) <= MAX_DOM_CHILD_INDEX)
  );
}

function hasValidOptionalBooleans(node: Record<string, unknown>): boolean {
  return ['empty', 'contentEditable', 'proseMirror', 'placeholder', 'virtualKeyboard', 'trailingBreak'].every(
    (field) => node[field] === undefined || typeof node[field] === 'boolean',
  );
}

function hasValidOptionalIntegers(node: Record<string, unknown>): boolean {
  return (
    (node.nodeType === undefined ||
      (Number.isInteger(node.nodeType) && Number(node.nodeType) >= 0 && Number(node.nodeType) <= 1_000)) &&
    (node.childCount === undefined ||
      (Number.isInteger(node.childCount) &&
        Number(node.childCount) >= 0 &&
        Number(node.childCount) <= MAX_DOM_CHILD_INDEX))
  );
}

function isFingerprintNode(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const node = value as Record<string, unknown>;
  if (Object.keys(node).some((field) => !FINGERPRINT_NODE_FIELDS.has(field))) return false;
  if (!isFingerprintPath(node.path)) return false;
  if (!['text', 'element', 'other'].includes(String(node.kind))) return false;
  if (node.tag !== undefined && (typeof node.tag !== 'string' || !/^[A-Z][A-Z0-9-]{0,31}$/.test(node.tag))) {
    return false;
  }
  return hasValidOptionalBooleans(node) && hasValidOptionalIntegers(node);
}

export function isCloudBridgeFailureDiagnosticV1(value: unknown): value is CloudBridgeFailureDiagnosticV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const diagnostic = value as Record<string, unknown>;
  if (Object.keys(diagnostic).some((field) => !DIAGNOSTIC_FIELDS.has(field))) return false;
  if (diagnostic.v !== 1 || !/^[A-Z][A-Z0-9_]{2,63}$/.test(String(diagnostic.errorCode))) return false;
  if (diagnostic.nextAction !== 'inspect_bound_tab') return false;
  const fingerprint = diagnostic.fingerprint;
  if (typeof fingerprint !== 'object' || fingerprint === null || Array.isArray(fingerprint)) return false;
  const record = fingerprint as Record<string, unknown>;
  if (Object.keys(record).some((field) => !FINGERPRINT_FIELDS.has(field))) return false;
  if (
    record.v !== 1 ||
    !isDiagnosticToken(record.phase) ||
    !isDiagnosticToken(record.adapterRevision) ||
    !isDiagnosticToken(record.artifactRevision) ||
    typeof record.truncated !== 'boolean' ||
    !Array.isArray(record.nodes) ||
    record.nodes.length > 12
  ) {
    return false;
  }
  if (record.firstUnsupportedPath !== undefined && !isFingerprintPath(record.firstUnsupportedPath)) {
    return false;
  }
  return record.nodes.every(isFingerprintNode);
}
