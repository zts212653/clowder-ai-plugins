import { FeishuGatewayError, type FeishuGeneratedArtifact } from './gateway.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const REQUIRED_POLLING_SCOPES = [
  'minutes:minutes.search:read',
  'vc:meeting.search:read',
  'vc:meeting.meetingevent:read',
  'vc:record:readonly',
] as const;
const MINUTE_DETAIL_SCOPES = [
  'minutes:minutes',
  'minutes:minutes:readonly',
  'minutes:minutes.basic:read',
] as const;

export interface SearchPage {
  readonly items: readonly Record<string, unknown>[];
  readonly hasMore: boolean;
  readonly pageToken: string;
}

export interface MeetingDetail {
  readonly meetingId: string;
  readonly topic?: string;
  readonly startTime?: string;
  readonly endTime?: string;
  readonly noteId?: string;
  readonly minuteToken?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unavailable(message: string): never {
  throw new FeishuGatewayError('UNAVAILABLE', message);
}

export function requirePollingAuthorization(value: unknown): void {
  if (!isRecord(value) || typeof value.verified !== 'boolean') {
    return unavailable('lark-cli authorization response is malformed');
  }
  if (!value.verified) {
    throw new FeishuGatewayError('AUTH_EXPIRED', 'lark-cli user authorization is not verified');
  }
  if (!isRecord(value.identities) || !isRecord(value.identities.user)) {
    throw new FeishuGatewayError('AUTH_EXPIRED', 'lark-cli user authorization is unavailable');
  }
  const rawScopes = value.identities.user.scope;
  if (typeof rawScopes !== 'string' || rawScopes.length > 32 * 1024) {
    return unavailable('lark-cli user authorization scopes are malformed');
  }
  const scopes = new Set(rawScopes.split(/[ ,]+/u).filter(Boolean));
  if (
    REQUIRED_POLLING_SCOPES.some(scope => !scopes.has(scope)) ||
    !MINUTE_DETAIL_SCOPES.some(scope => scopes.has(scope))
  ) {
    throw new FeishuGatewayError(
      'PERMISSION_DENIED',
      'lark-cli user authorization does not cover Feishu meeting polling',
    );
  }
}

function requireData(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.data)) {
    return unavailable('lark-cli read response is malformed');
  }
  return value.data;
}

export function requireSearchPage(value: unknown): SearchPage {
  const data = requireData(value);
  if (!Array.isArray(data.items) || typeof data.has_more !== 'boolean') {
    return unavailable('lark-cli search response is malformed');
  }
  const items = data.items.map(item => {
    if (!isRecord(item)) return unavailable('lark-cli search item is malformed');
    return item;
  });
  const pageToken = data.page_token;
  if (typeof pageToken !== 'string' || (data.has_more && pageToken.length < 1)) {
    return unavailable('lark-cli search cursor is malformed');
  }
  return { items, hasMore: data.has_more, pageToken };
}

export function safeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || !SAFE_ID.test(value)) {
    return unavailable(`lark-cli ${label} is malformed`);
  }
  return value;
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 512) {
    return unavailable(`lark-cli ${label} is malformed`);
  }
  const text = value.trim();
  return text.length === 0 ? undefined : text;
}

function timestamp(value: unknown, label: string): { readonly revision: string; readonly iso: string } {
  if (typeof value !== 'string' || !/^\d{13}$/u.test(value)) {
    return unavailable(`lark-cli ${label} is malformed`);
  }
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds)) return unavailable(`lark-cli ${label} is malformed`);
  return { revision: value, iso: new Date(milliseconds).toISOString() };
}

function flexibleTimestamp(value: unknown, label: string): { readonly revision: string; readonly iso: string } {
  if (typeof value !== 'string' || value.length < 1) {
    return unavailable(`lark-cli ${label} is malformed`);
  }
  const milliseconds = /^\d+$/u.test(value)
    ? Number(value) * (value.length <= 10 ? 1_000 : 1)
    : Date.parse(value);
  if (!Number.isSafeInteger(milliseconds)) return unavailable(`lark-cli ${label} is malformed`);
  return { revision: String(milliseconds), iso: new Date(milliseconds).toISOString() };
}

export function requireMeetingDetails(value: unknown): MeetingDetail[] {
  const data = requireData(value);
  if (!Array.isArray(data.meetings)) return unavailable('lark-cli VC detail response is malformed');
  return data.meetings.map(candidate => {
    if (!isRecord(candidate) || optionalText(candidate.error, 'VC detail error') !== undefined) {
      return unavailable('lark-cli VC detail item is malformed');
    }
    const topic = optionalText(candidate.topic, 'meeting topic');
    const startTime = optionalText(candidate.start_time, 'meeting start time');
    const endTime = optionalText(candidate.end_time, 'meeting end time');
    return {
      meetingId: safeId(candidate.meeting_id, 'meeting ID'),
      ...(topic === undefined ? {} : { topic }),
      ...(startTime === undefined ? {} : { startTime }),
      ...(endTime === undefined ? {} : { endTime }),
      ...(candidate.note_id === undefined || candidate.note_id === ''
        ? {} : { noteId: safeId(candidate.note_id, 'note ID') }),
      ...(candidate.minute_token === undefined || candidate.minute_token === ''
        ? {} : { minuteToken: safeId(candidate.minute_token, 'minute token') }),
    };
  });
}

export function minuteArtifacts(
  value: unknown,
  meeting: MeetingDetail | undefined,
): FeishuGeneratedArtifact[] {
  const data = requireData(value);
  if (!isRecord(data.minute)) return unavailable('lark-cli minute detail response is malformed');
  const minute = data.minute;
  const artifactId = safeId(minute.token, 'minute token');
  const created = timestamp(minute.create_time, 'minute create time');
  const title = optionalText(minute.title, 'minute title') ?? meeting?.topic;
  const common = {
    revision: created.revision,
    generatedAt: created.iso,
    ...(title === undefined ? {} : { title }),
    ...(meeting === undefined ? {} : { meetingId: meeting.meetingId }),
  };
  const artifacts: FeishuGeneratedArtifact[] = [{ artifactId, kind: 'minute', ...common }];
  if (minute.note_id !== undefined && minute.note_id !== '') {
    artifacts.push({ artifactId: safeId(minute.note_id, 'note ID'), kind: 'note', ...common });
  }
  return artifacts;
}

export function noteArtifact(meeting: MeetingDetail): FeishuGeneratedArtifact {
  if (meeting.noteId === undefined) return unavailable('lark-cli meeting note ID is missing');
  const generated = flexibleTimestamp(
    meeting.endTime ?? meeting.startTime,
    'meeting generated time',
  );
  return {
    artifactId: meeting.noteId,
    kind: 'note',
    revision: generated.revision,
    generatedAt: generated.iso,
    ...(meeting.topic === undefined ? {} : { title: meeting.topic }),
    meetingId: meeting.meetingId,
  };
}

export function stableArtifacts(values: readonly FeishuGeneratedArtifact[]): FeishuGeneratedArtifact[] {
  const byArtifact = new Map<string, FeishuGeneratedArtifact>();
  for (const value of values) {
    const key = `${value.kind}:${value.artifactId}`;
    if (!byArtifact.has(key)) byArtifact.set(key, value);
  }
  return [...byArtifact.values()].sort((left, right) =>
    left.generatedAt.localeCompare(right.generatedAt) ||
    left.kind.localeCompare(right.kind) ||
    left.artifactId.localeCompare(right.artifactId));
}
