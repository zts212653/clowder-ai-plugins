/**
 * Closed v1 grammar for the F247 Personal Chrome companion.
 *
 * This module deliberately describes only the companion's narrow local and
 * Native Messaging messages. It is not a PluginManifest or a generic browser
 * extension transport.
 */
export const PERSONAL_CHROME_PROTOCOL_VERSION = 1 as const;
export const PERSONAL_CHROME_MAX_TEXT_BYTES = 128 * 1024;
export const PERSONAL_CHROME_MAX_LOCAL_FRAME_BYTES = 256 * 1024;

const SAFE_TOKEN = /^[A-Za-z0-9._:-]+$/;
const SAFE_CONVERSATION_ID = /^[A-Za-z0-9-]+$/;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const SAFE_PAIRING_SECRET = /^[A-Za-z0-9_-]{43,512}$/;

export interface PersonalChromeAppendRequest {
  readonly v: typeof PERSONAL_CHROME_PROTOCOL_VERSION;
  readonly kind: 'append_message';
  readonly requestId: string;
  readonly conversationId: string;
  readonly text: string;
  readonly idempotencyKey: string;
}

export interface PersonalChromeAppendProgress {
  readonly v: typeof PERSONAL_CHROME_PROTOCOL_VERSION;
  readonly kind: 'append_progress';
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly status: 'extension_received' | 'inserted' | 'submitted';
}

export interface PersonalChromeAppendSuccess {
  readonly v: typeof PERSONAL_CHROME_PROTOCOL_VERSION;
  readonly kind: 'append_result';
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly status: 'host_observed';
  readonly hostMessageId: string;
}

export interface PersonalChromeAppendFailure {
  readonly v: typeof PERSONAL_CHROME_PROTOCOL_VERSION;
  readonly kind: 'append_result';
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly status: 'failed';
  readonly errorCode: string;
}

export type PersonalChromeAppendResult = PersonalChromeAppendSuccess | PersonalChromeAppendFailure;

export interface PersonalChromeBindingRequest {
  readonly v: typeof PERSONAL_CHROME_PROTOCOL_VERSION;
  readonly kind: 'bind_conversation';
  readonly requestId: string;
  readonly conversationId: string;
  readonly chatUrl: string;
}

export interface PersonalChromeBindingQuery {
  readonly v: typeof PERSONAL_CHROME_PROTOCOL_VERSION;
  readonly kind: 'query_binding';
  readonly requestId: string;
}

export interface PersonalChromeBindingResultBound {
  readonly v: typeof PERSONAL_CHROME_PROTOCOL_VERSION;
  readonly kind: 'binding_result';
  readonly requestId: string;
  readonly status: 'bound';
  readonly conversationId: string;
  readonly boundAt: string;
}

export interface PersonalChromeBindingFailure {
  readonly v: typeof PERSONAL_CHROME_PROTOCOL_VERSION;
  readonly kind: 'binding_result';
  readonly requestId: string;
  readonly status: 'failed';
  readonly errorCode: string;
}

export type PersonalChromeBindingResult = PersonalChromeBindingResultBound | PersonalChromeBindingFailure;

export interface PersonalChromeBindingStatusBound {
  readonly v: typeof PERSONAL_CHROME_PROTOCOL_VERSION;
  readonly kind: 'binding_status';
  readonly requestId: string;
  readonly status: 'bound';
  readonly conversationId: string;
  readonly boundAt: string;
}

export interface PersonalChromeBindingStatusUnbound {
  readonly v: typeof PERSONAL_CHROME_PROTOCOL_VERSION;
  readonly kind: 'binding_status';
  readonly requestId: string;
  readonly status: 'unbound';
  readonly errorCode: 'NEEDS_BINDING';
}

export interface PersonalChromeBindingStatusFailure {
  readonly v: typeof PERSONAL_CHROME_PROTOCOL_VERSION;
  readonly kind: 'binding_status';
  readonly requestId: string;
  readonly status: 'failed';
  readonly errorCode: string;
}

export type PersonalChromeBindingStatus =
  | PersonalChromeBindingStatusBound
  | PersonalChromeBindingStatusUnbound
  | PersonalChromeBindingStatusFailure;

export type PersonalChromeNativeMessage =
  | PersonalChromeAppendRequest
  | PersonalChromeAppendProgress
  | PersonalChromeAppendResult
  | PersonalChromeBindingRequest
  | PersonalChromeBindingQuery
  | PersonalChromeBindingResult
  | PersonalChromeBindingStatus;

export interface PersonalChromeLocalEnvelope {
  readonly pairingSecret: string;
  readonly request: PersonalChromeAppendRequest;
}

type RecordValue = Record<string, unknown>;

function asExactRecord(value: unknown, label: string, fields: readonly string[]): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as RecordValue;
  const expected = new Set(fields);
  for (const key of Object.keys(record)) {
    if (!expected.has(key)) throw new Error(`${label} has an unknown field: ${key}`);
  }
  for (const field of fields) {
    if (!Object.hasOwn(record, field)) throw new Error(`${label} is missing field: ${field}`);
  }
  return record;
}

function requireString(
  value: unknown,
  label: string,
  { maxLength, pattern, allowWhitespace = false }: { maxLength: number; pattern?: RegExp; allowWhitespace?: boolean },
): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`${label} must be a non-empty string of at most ${maxLength} characters`);
  }
  if (!allowWhitespace && value.trim() !== value) throw new Error(`${label} must not have surrounding whitespace`);
  if (pattern !== undefined && !pattern.test(value)) throw new Error(`${label} has an invalid format`);
  return value;
}

function requireRequestId(value: unknown): string {
  return requireString(value, 'requestId', { maxLength: 200, pattern: SAFE_TOKEN });
}

function requireConversationId(value: unknown): string {
  return requireString(value, 'conversationId', { maxLength: 200, pattern: SAFE_CONVERSATION_ID });
}

function requireIdempotencyKey(value: unknown): string {
  return requireString(value, 'idempotencyKey', { maxLength: 512, pattern: SAFE_TOKEN });
}

function requireErrorCode(value: unknown): string {
  return requireString(value, 'errorCode', { maxLength: 64, pattern: SAFE_ERROR_CODE });
}

function requireCanonicalTimestamp(value: unknown, label: string): string {
  const timestamp = requireString(value, label, { maxLength: 40 });
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return timestamp;
}

export function conversationIdFromExactChatGptUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com' || url.search || url.hash) return null;
    return url.pathname.match(/^\/c\/([A-Za-z0-9-]{1,200})\/?$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function parsePersonalChromeAppendRequest(value: unknown): PersonalChromeAppendRequest {
  const record = asExactRecord(value, 'append request', [
    'v',
    'kind',
    'requestId',
    'conversationId',
    'text',
    'idempotencyKey',
  ]);
  if (record.v !== PERSONAL_CHROME_PROTOCOL_VERSION || record.kind !== 'append_message') {
    throw new Error('append request has an unsupported protocol shape');
  }
  const text = requireString(record.text, 'text', {
    maxLength: PERSONAL_CHROME_MAX_TEXT_BYTES,
    allowWhitespace: true,
  });
  if (text.trim().length === 0 || Buffer.byteLength(text, 'utf8') > PERSONAL_CHROME_MAX_TEXT_BYTES) {
    throw new Error(`text exceeds ${PERSONAL_CHROME_MAX_TEXT_BYTES} bytes`);
  }
  return {
    v: PERSONAL_CHROME_PROTOCOL_VERSION,
    kind: 'append_message',
    requestId: requireRequestId(record.requestId),
    conversationId: requireConversationId(record.conversationId),
    text,
    idempotencyKey: requireIdempotencyKey(record.idempotencyKey),
  };
}

export function parsePersonalChromeAppendProgress(value: unknown): PersonalChromeAppendProgress {
  const record = asExactRecord(value, 'append progress', ['v', 'kind', 'requestId', 'idempotencyKey', 'status']);
  if (record.v !== PERSONAL_CHROME_PROTOCOL_VERSION || record.kind !== 'append_progress') {
    throw new Error('append progress has an unsupported protocol shape');
  }
  if (!['extension_received', 'inserted', 'submitted'].includes(record.status as string)) {
    throw new Error('append progress has an unsupported status');
  }
  return {
    v: PERSONAL_CHROME_PROTOCOL_VERSION,
    kind: 'append_progress',
    requestId: requireRequestId(record.requestId),
    idempotencyKey: requireIdempotencyKey(record.idempotencyKey),
    status: record.status as PersonalChromeAppendProgress['status'],
  };
}

export function parsePersonalChromeAppendResult(value: unknown): PersonalChromeAppendResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('append result must be an object');
  }
  const status = (value as RecordValue).status;
  const fields =
    status === 'host_observed'
      ? ['v', 'kind', 'requestId', 'idempotencyKey', 'status', 'hostMessageId']
      : status === 'failed'
        ? ['v', 'kind', 'requestId', 'idempotencyKey', 'status', 'errorCode']
        : ['v', 'kind', 'requestId', 'idempotencyKey', 'status'];
  const record = asExactRecord(value, 'append result', fields);
  if (record.v !== PERSONAL_CHROME_PROTOCOL_VERSION || record.kind !== 'append_result') {
    throw new Error('append result has an unsupported protocol shape');
  }
  const base = {
    v: PERSONAL_CHROME_PROTOCOL_VERSION,
    kind: 'append_result' as const,
    requestId: requireRequestId(record.requestId),
    idempotencyKey: requireIdempotencyKey(record.idempotencyKey),
  };
  if (record.status === 'host_observed') {
    return {
      ...base,
      status: 'host_observed',
      hostMessageId: requireString(record.hostMessageId, 'hostMessageId', { maxLength: 512, pattern: SAFE_TOKEN }),
    };
  }
  if (record.status === 'failed') {
    return { ...base, status: 'failed', errorCode: requireErrorCode(record.errorCode) };
  }
  throw new Error('append result status must be host_observed or failed');
}

export function parsePersonalChromeBindingRequest(value: unknown): PersonalChromeBindingRequest {
  const record = asExactRecord(value, 'binding request', [
    'v',
    'kind',
    'requestId',
    'conversationId',
    'chatUrl',
  ]);
  if (record.v !== PERSONAL_CHROME_PROTOCOL_VERSION || record.kind !== 'bind_conversation') {
    throw new Error('binding request has an unsupported protocol shape');
  }
  const conversationId = requireConversationId(record.conversationId);
  const chatUrl = requireString(record.chatUrl, 'chatUrl', { maxLength: 240 });
  if (conversationIdFromExactChatGptUrl(chatUrl) !== conversationId) {
    throw new Error('chatUrl must be the exact ChatGPT conversation URL');
  }
  return {
    v: PERSONAL_CHROME_PROTOCOL_VERSION,
    kind: 'bind_conversation',
    requestId: requireRequestId(record.requestId),
    conversationId,
    chatUrl,
  };
}

export function parsePersonalChromeBindingQuery(value: unknown): PersonalChromeBindingQuery {
  const record = asExactRecord(value, 'binding query', ['v', 'kind', 'requestId']);
  if (record.v !== PERSONAL_CHROME_PROTOCOL_VERSION || record.kind !== 'query_binding') {
    throw new Error('binding query has an unsupported protocol shape');
  }
  return { v: PERSONAL_CHROME_PROTOCOL_VERSION, kind: 'query_binding', requestId: requireRequestId(record.requestId) };
}

export function parsePersonalChromeBindingResult(value: unknown): PersonalChromeBindingResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('binding result must be an object');
  }
  const status = (value as RecordValue).status;
  const fields =
    status === 'bound'
      ? ['v', 'kind', 'requestId', 'status', 'conversationId', 'boundAt']
      : status === 'failed'
        ? ['v', 'kind', 'requestId', 'status', 'errorCode']
        : ['v', 'kind', 'requestId', 'status'];
  const record = asExactRecord(value, 'binding result', fields);
  if (record.v !== PERSONAL_CHROME_PROTOCOL_VERSION || record.kind !== 'binding_result') {
    throw new Error('binding result has an unsupported protocol shape');
  }
  const requestId = requireRequestId(record.requestId);
  if (record.status === 'bound') {
    return {
      v: PERSONAL_CHROME_PROTOCOL_VERSION,
      kind: 'binding_result',
      requestId,
      status: 'bound',
      conversationId: requireConversationId(record.conversationId),
      boundAt: requireCanonicalTimestamp(record.boundAt, 'boundAt'),
    };
  }
  if (record.status === 'failed') {
    return { v: PERSONAL_CHROME_PROTOCOL_VERSION, kind: 'binding_result', requestId, status: 'failed', errorCode: requireErrorCode(record.errorCode) };
  }
  throw new Error('binding result status must be bound or failed');
}

export function parsePersonalChromeBindingStatus(value: unknown): PersonalChromeBindingStatus {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('binding status must be an object');
  }
  const status = (value as RecordValue).status;
  const fields =
    status === 'bound'
      ? ['v', 'kind', 'requestId', 'status', 'conversationId', 'boundAt']
      : status === 'unbound' || status === 'failed'
        ? ['v', 'kind', 'requestId', 'status', 'errorCode']
        : ['v', 'kind', 'requestId', 'status'];
  const record = asExactRecord(value, 'binding status', fields);
  if (record.v !== PERSONAL_CHROME_PROTOCOL_VERSION || record.kind !== 'binding_status') {
    throw new Error('binding status has an unsupported protocol shape');
  }
  const requestId = requireRequestId(record.requestId);
  if (record.status === 'bound') {
    return {
      v: PERSONAL_CHROME_PROTOCOL_VERSION,
      kind: 'binding_status',
      requestId,
      status: 'bound',
      conversationId: requireConversationId(record.conversationId),
      boundAt: requireCanonicalTimestamp(record.boundAt, 'boundAt'),
    };
  }
  if (record.status === 'unbound') {
    if (record.errorCode !== 'NEEDS_BINDING') throw new Error('unbound status must report NEEDS_BINDING');
    return { v: PERSONAL_CHROME_PROTOCOL_VERSION, kind: 'binding_status', requestId, status: 'unbound', errorCode: 'NEEDS_BINDING' };
  }
  if (record.status === 'failed') {
    return { v: PERSONAL_CHROME_PROTOCOL_VERSION, kind: 'binding_status', requestId, status: 'failed', errorCode: requireErrorCode(record.errorCode) };
  }
  throw new Error('binding status must be bound, unbound, or failed');
}

export function parsePersonalChromeLocalEnvelope(value: unknown): PersonalChromeLocalEnvelope {
  const record = asExactRecord(value, 'local envelope', ['pairingSecret', 'request']);
  return {
    pairingSecret: requireString(record.pairingSecret, 'pairingSecret', { maxLength: 512, pattern: SAFE_PAIRING_SECRET }),
    request: parsePersonalChromeAppendRequest(record.request),
  };
}

export function sameAppendCorrelation(
  request: Pick<PersonalChromeAppendRequest, 'requestId' | 'idempotencyKey'>,
  result: Pick<PersonalChromeAppendResult, 'requestId' | 'idempotencyKey'>,
): boolean {
  return request.requestId === result.requestId && request.idempotencyKey === result.idempotencyKey;
}
