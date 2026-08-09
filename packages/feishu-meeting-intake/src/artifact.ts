import { createRequire } from 'node:module';

import {
  validateDeclaredEventsPublishInput,
  type EventsPublishInput,
  type SignalDeclaration,
  type SignalSchemaCatalog,
  type SignalValidationResult,
} from '@clowder-ai/plugin-contract';

import type {
  FeishuArtifactKind,
  FeishuArtifactLocator,
  FeishuTranscriptGateway,
  FeishuGeneratedArtifact,
  FeishuTranscript,
} from './gateway.js';

export const FEISHU_MEETING_SIGNAL_TYPE =
  'feishu.meeting_artifact.generated.v1' as const;
export const FEISHU_MEETING_SIGNAL_SCHEMA_REF =
  'schemas/feishu-meeting-artifact.schema.json' as const;

export const FEISHU_MEETING_SIGNAL_DECLARATION = {
  type: FEISHU_MEETING_SIGNAL_TYPE,
  schemaRef: FEISHU_MEETING_SIGNAL_SCHEMA_REF,
  epistemicStatus: 'observation',
  privacyClass: 'content-adjacent',
  sourceClass: 'remote-service',
} as const satisfies SignalDeclaration;

const require = createRequire(import.meta.url);
const meetingArtifactSchema = require('../schemas/feishu-meeting-artifact.schema.json') as Readonly<
  Record<string, unknown>
>;
export const FEISHU_MEETING_SIGNAL_SCHEMAS: SignalSchemaCatalog = Object.freeze({
  [FEISHU_MEETING_SIGNAL_SCHEMA_REF]: meetingArtifactSchema,
});

const DESCRIPTOR_KEYS = new Set([
  'artifactId',
  'kind',
  'revision',
  'generatedAt',
  'title',
  'meetingId',
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedSafeId(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= maximum &&
    SAFE_ID.test(value)
  );
}

function requireDescriptor(value: unknown): FeishuGeneratedArtifact {
  if (!isRecord(value)) throw new TypeError('Feishu artifact descriptor must be an object');
  for (const key of Object.keys(value)) {
    if (!DESCRIPTOR_KEYS.has(key)) {
      throw new TypeError(`Feishu artifact descriptor contains forbidden field: ${key}`);
    }
  }
  if (!boundedSafeId(value.artifactId, 128)) {
    throw new TypeError('Feishu artifactId must be a bounded opaque identifier');
  }
  if (value.kind !== 'note' && value.kind !== 'minute') {
    throw new TypeError('Feishu artifact kind must be note or minute');
  }
  if (!boundedSafeId(value.revision, 64)) {
    throw new TypeError('Feishu revision must be a bounded opaque identifier');
  }
  if (typeof value.generatedAt !== 'string') {
    throw new TypeError('Feishu generatedAt must be an RFC3339 UTC string');
  }
  if (
    value.title !== undefined &&
    (typeof value.title !== 'string' || value.title.length < 1 || value.title.length > 512)
  ) {
    throw new TypeError('Feishu artifact title must be 1..512 characters');
  }
  if (value.meetingId !== undefined && !boundedSafeId(value.meetingId, 128)) {
    throw new TypeError('Feishu meetingId must be a bounded opaque identifier');
  }

  return {
    artifactId: value.artifactId,
    kind: value.kind,
    revision: value.revision,
    generatedAt: value.generatedAt,
    ...(value.title === undefined ? {} : { title: value.title }),
    ...(value.meetingId === undefined ? {} : { meetingId: value.meetingId }),
  };
}

function sourceHandle(descriptor: FeishuGeneratedArtifact): string {
  return `feishu://meeting-artifacts/${descriptor.kind}/${descriptor.artifactId}?revision=${descriptor.revision}`;
}

export function normalizeGeneratedArtifact(value: unknown): EventsPublishInput {
  const descriptor = requireDescriptor(value);
  const payload = {
    artifactId: descriptor.artifactId,
    artifactKind: descriptor.kind,
    revision: descriptor.revision,
    ...(descriptor.title === undefined ? {} : { title: descriptor.title }),
    ...(descriptor.meetingId === undefined ? {} : { meetingId: descriptor.meetingId }),
  };
  const input = {
    signalType: FEISHU_MEETING_SIGNAL_TYPE,
    eventId: `feishu-${descriptor.kind}-${descriptor.artifactId}-v${descriptor.revision}`,
    idempotencyKey: `feishu:${descriptor.kind}:${descriptor.artifactId}:${descriptor.revision}`,
    occurredAt: descriptor.generatedAt,
    payload,
    source: { handle: sourceHandle(descriptor) },
  } satisfies EventsPublishInput;
  const validation = validateFeishuMeetingPublishInput(input);
  if (!validation.valid) {
    throw new TypeError(
      `Feishu artifact cannot form a signal: ${validation.errors
        .map(({ instancePath, message }) => `${instancePath || '/'} ${message}`)
        .join('; ')}`,
    );
  }
  return structuredClone(validation.value);
}

export function validateFeishuMeetingPublishInput(
  value: unknown,
): SignalValidationResult<EventsPublishInput> {
  const validation = validateDeclaredEventsPublishInput(
    [FEISHU_MEETING_SIGNAL_DECLARATION],
    FEISHU_MEETING_SIGNAL_SCHEMAS,
    value,
  );
  if (!validation.valid) return validation;

  const payload = validation.value.payload as Record<string, unknown>;
  const locator = parseFeishuSourceHandle(validation.value.source.handle);
  if (
    payload.artifactId !== locator.artifactId ||
    payload.artifactKind !== locator.kind ||
    payload.revision !== locator.revision
  ) {
    return {
      valid: false,
      errors: [
        {
          instancePath: '/source/handle',
          schemaPath: FEISHU_MEETING_SIGNAL_SCHEMA_REF,
          keyword: 'sourceBinding',
          message: 'source handle must identify the exact payload artifact and revision',
        },
      ],
    };
  }
  return validation;
}

export function parseFeishuSourceHandle(value: string): Required<FeishuArtifactLocator> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Feishu source handle must be a canonical feishu URL');
  }
  if (
    url.protocol !== 'feishu:' ||
    url.hostname !== 'meeting-artifacts' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    throw new TypeError('Feishu source handle has invalid authority');
  }
  const path = url.pathname.split('/').filter(Boolean);
  if (path.length !== 2 || (path[0] !== 'note' && path[0] !== 'minute')) {
    throw new TypeError('Feishu source handle has invalid path');
  }
  if ([...url.searchParams.keys()].join(',') !== 'revision') {
    throw new TypeError('Feishu source handle has unexpected query fields');
  }
  const revision = url.searchParams.get('revision');
  if (!boundedSafeId(path[1], 128) || !boundedSafeId(revision, 64)) {
    throw new TypeError('Feishu source handle has invalid identifiers');
  }
  return { artifactId: path[1], kind: path[0] as FeishuArtifactKind, revision };
}

function requireTranscript(value: unknown): FeishuTranscript {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== 'text' && key !== 'contentType') ||
    typeof value.text !== 'string' ||
    value.contentType !== 'text/plain' ||
    Buffer.byteLength(value.text, 'utf8') > MAX_TRANSCRIPT_BYTES
  ) {
    throw new TypeError('Feishu transcript response is invalid or too large');
  }
  return { text: value.text, contentType: 'text/plain' };
}

export interface FeishuTranscriptSourceAdapter {
  resolve(access: {
    readonly sourceHandle: string;
    readonly intakeId: string;
    readonly sourceGrant: string;
  }, signal: AbortSignal): Promise<FeishuTranscript>;
}

export function createFeishuTranscriptSourceAdapter(
  gateway: FeishuTranscriptGateway,
): FeishuTranscriptSourceAdapter {
  return {
    async resolve(access, signal): Promise<FeishuTranscript> {
      if (!boundedSafeId(access.intakeId, 128)) {
        throw new TypeError('Feishu transcript access requires a bounded intake binding');
      }
      if (
        typeof access.sourceGrant !== 'string' ||
        access.sourceGrant.length < 1 ||
        access.sourceGrant.length > 2048 ||
        /[\u0000-\u001F\u007F]/u.test(access.sourceGrant)
      ) {
        throw new TypeError('Feishu transcript access requires a Host-issued source grant');
      }
      const locator = parseFeishuSourceHandle(access.sourceHandle);
      return requireTranscript(await gateway.resolveGrantedTranscript({
        locator,
        sourceHandle: access.sourceHandle,
        intakeId: access.intakeId,
        sourceGrant: access.sourceGrant,
        signal,
      }));
    },
  };
}
