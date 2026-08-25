import {
  FeishuCatchUpRequiredError,
  FeishuGatewayError,
  type FeishuArtifactLocator,
  type FeishuCatchUpDetector,
  type FeishuCatchUpScanner,
  type FeishuGeneratedArtifact,
  type FeishuGeneratedArtifactPage,
  type FeishuPollingGateway,
} from './gateway.js';
import {
  createDefaultLarkCliReadCommand,
  type LarkCliReadCommand,
} from './lark-cli-read-command.js';
import {
  minuteArtifacts,
  noteArtifact,
  requireMeetingDetails,
  requirePollingAuthorization,
  requireSearchPage,
  safeId,
  stableArtifacts,
  type MeetingDetail,
} from './lark-cli-polling-normalizer.js';
import { createLarkCliFeishuArtifactInspector } from './lark-cli-artifact-inspector.js';
import { abortableSleep } from './abortable-sleep.js';

const CURSOR_PREFIX = 'poll-v1:';
const DEFAULT_LOOKBACK_MS = 5 * 60_000;
const DEFAULT_OVERLAP_MS = 30_000;
const DEFAULT_SEARCH_CONSISTENCY_LAG_MS = 10 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_MAX_AUTOMATIC_CATCH_UP_MS = 60 * 60_000;
const SEARCH_PAGE_SIZE = 30;
const MAX_SEARCH_PAGES = 4;
const MAX_CANDIDATES = 64;
const VC_DETAIL_BATCH_SIZE = 50;

export type { LarkCliReadCommand } from './lark-cli-read-command.js';

export interface LarkCliFeishuPollingGateway extends FeishuPollingGateway,
  FeishuCatchUpDetector, FeishuCatchUpScanner {
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface LarkCliFeishuPollingGatewayOptions {
  readonly homeDirectory: string;
  readonly now?: () => number;
  readonly lookbackMs?: number;
  readonly overlapMs?: number;
  readonly searchConsistencyLagMs?: number;
  readonly pollIntervalMs?: number;
  readonly maxAutomaticCatchUpMs?: number;
  readonly runCommand?: LarkCliReadCommand;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly inspectArtifact?: (locator: FeishuArtifactLocator, signal: AbortSignal) => Promise<unknown>;
}

function unavailable(message: string): never {
  throw new FeishuGatewayError('UNAVAILABLE', message);
}
function parseCursor(cursor: string | null, now: number, safeEnd: number, lookbackMs: number,
  overlapMs: number) {
  if (cursor === null || !cursor.startsWith(CURSOR_PREFIX)) return Math.max(0, safeEnd - lookbackMs);
  const value = Number(cursor.slice(CURSOR_PREFIX.length));
  if (!Number.isSafeInteger(value) || value < 0 || value > now) {
    return unavailable('Feishu polling cursor is malformed');
  }
  return Math.max(0, Math.min(value, safeEnd) - overlapMs);
}

function cursor(value: number): string {
  return `${CURSOR_PREFIX}${value}`;
}
function catchUpBoundary(
  inputCursor: string | null,
  lastSuccessfulObservationAt: number | null | undefined,
  now: number,
): { readonly cursor: string; readonly timestamp: number } | undefined {
  if (inputCursor?.startsWith(CURSOR_PREFIX)) {
    const timestamp = Number(inputCursor.slice(CURSOR_PREFIX.length));
    if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > now) {
      return unavailable('Feishu polling cursor is malformed');
    }
    return { cursor: inputCursor, timestamp };
  }
  if (
    lastSuccessfulObservationAt !== undefined && lastSuccessfulObservationAt !== null &&
    Number.isSafeInteger(lastSuccessfulObservationAt) && lastSuccessfulObservationAt >= 0 &&
    lastSuccessfulObservationAt <= now
  ) {
    return { cursor: cursor(lastSuccessfulObservationAt), timestamp: lastSuccessfulObservationAt };
  }
  return undefined;
}

function searchArgs(
  source: 'minutes-owner' | 'minutes-participant' | 'vc',
  start: number,
  end: number,
  pageSize: number,
  pageToken?: string,
): string[] {
  const args = source === 'vc'
    ? ['vc', '+search']
    : ['minutes', '+search', source === 'minutes-owner' ? '--owner-ids' : '--participant-ids', 'me'];
  args.push(
    '--start', new Date(start).toISOString(),
    '--end', new Date(end).toISOString(),
    '--page-size', String(pageSize),
    '--as', 'user',
    '--format', 'json',
  );
  if (pageToken !== undefined) args.push('--page-token', pageToken);
  return args;
}

async function collectSearch(
  runCommand: LarkCliReadCommand,
  source: 'minutes-owner' | 'minutes-participant' | 'vc',
  start: number,
  end: number,
  fromCursor: string | null,
  throughCursor: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_SEARCH_PAGES; page += 1) {
    const response = requireSearchPage(await runCommand(
      searchArgs(source, start, end, SEARCH_PAGE_SIZE, pageToken),
      signal,
    ));
    items.push(...response.items);
    if (items.length > MAX_CANDIDATES) {
      throw new FeishuCatchUpRequiredError({
        fromCursor,
        throughCursor,
        reason: 'CANDIDATE_BOUND',
        candidateCountAtLeast: items.length,
      });
    }
    if (!response.hasMore) return items;
    pageToken = response.pageToken;
  }
  throw new FeishuCatchUpRequiredError({
    fromCursor,
    throughCursor,
    reason: 'PAGE_BOUND',
    candidateCountAtLeast: MAX_SEARCH_PAGES * SEARCH_PAGE_SIZE + 1,
  });
}

export function createLarkCliFeishuPollingGateway(
  options: LarkCliFeishuPollingGatewayOptions,
): LarkCliFeishuPollingGateway {
  const now = options.now ?? Date.now;
  const lookbackMs = options.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const overlapMs = options.overlapMs ?? DEFAULT_OVERLAP_MS;
  const searchConsistencyLagMs = options.searchConsistencyLagMs ??
    DEFAULT_SEARCH_CONSISTENCY_LAG_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxAutomaticCatchUpMs = options.maxAutomaticCatchUpMs ??
    DEFAULT_MAX_AUTOMATIC_CATCH_UP_MS;
  for (const [label, value] of Object.entries({
    lookbackMs,
    overlapMs,
    searchConsistencyLagMs,
    pollIntervalMs,
    maxAutomaticCatchUpMs,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be positive`);
  }
  const runCommand = options.runCommand ?? createDefaultLarkCliReadCommand(options.homeDirectory);
  const inspectArtifact = options.inspectArtifact ?? createLarkCliFeishuArtifactInspector({
    homeDirectory: options.homeDirectory,
    runCommand,
  });
  const sleep = options.sleep ?? abortableSleep;
  const lifecycle = new AbortController();
  let starting: Promise<void> | undefined;
  let buffered: FeishuGeneratedArtifact[] = [];
  let bufferedInputCursor: string | null = null;
  let bufferedNextCursor: string | null = null;

  const start = (): Promise<void> => {
    starting ??= (async () => {
      const end = now();
      const signal = lifecycle.signal;
      requirePollingAuthorization(await runCommand(
        ['auth', 'status', '--json', '--verify'],
        signal,
      ));
      for (const source of ['minutes-owner', 'minutes-participant', 'vc'] as const) {
        requireSearchPage(await runCommand(searchArgs(source, end - 1_000, end, 1), signal));
      }
    })();
    return starting;
  };

  const collectWindow = async (
    fromCursor: string | null,
    end: number,
    currentTime: number,
    signal: AbortSignal,
  ): Promise<{ readonly artifacts: FeishuGeneratedArtifact[]; readonly nextCursor: string }> => {
    const throughCursor = cursor(end);
    const begin = parseCursor(fromCursor, currentTime, end, lookbackMs, overlapMs);
    const [owned, participated, meetingItems] = await Promise.all([
      collectSearch(runCommand, 'minutes-owner', begin, end, fromCursor, throughCursor, signal),
      collectSearch(runCommand, 'minutes-participant', begin, end, fromCursor, throughCursor, signal),
      collectSearch(runCommand, 'vc', begin, end, fromCursor, throughCursor, signal),
    ]);
    const minuteTokens = new Set<string>();
    for (const item of [...owned, ...participated]) {
      minuteTokens.add(safeId(item.token, 'minute search token'));
    }
    const meetingIds = [...new Set(meetingItems.map(item => safeId(item.id, 'meeting search ID')))];
    const meetings: MeetingDetail[] = [];
    for (let index = 0; index < meetingIds.length; index += VC_DETAIL_BATCH_SIZE) {
      const ids = meetingIds.slice(index, index + VC_DETAIL_BATCH_SIZE);
      meetings.push(...requireMeetingDetails(await runCommand([
        'vc', '+detail', '--meeting-ids', ids.join(','), '--as', 'user', '--format', 'json',
      ], signal)));
    }
    const meetingByMinute = new Map<string, MeetingDetail>();
    const meetingByNote = new Map<string, MeetingDetail>();
    for (const meeting of meetings) {
      if (meeting.minuteToken !== undefined) {
        minuteTokens.add(meeting.minuteToken);
        meetingByMinute.set(meeting.minuteToken, meeting);
      }
      if (meeting.noteId !== undefined) meetingByNote.set(meeting.noteId, meeting);
    }
    if (minuteTokens.size + meetings.length > MAX_CANDIDATES) {
      throw new FeishuCatchUpRequiredError({
        fromCursor,
        throughCursor,
        reason: 'CANDIDATE_BOUND',
        candidateCountAtLeast: minuteTokens.size + meetings.length,
      });
    }
    const artifacts: FeishuGeneratedArtifact[] = [];
    const meetingIdsWithMinute = new Set<string>();
    for (const token of minuteTokens) {
      const minutes = minuteArtifacts(await runCommand([
        'minutes', 'minutes', 'get', '--minute-token', token,
        '--as', 'user', '--format', 'json',
      ], signal), meetingByMinute.get(token), meetingByNote);
      artifacts.push(...minutes);
      for (const minute of minutes) {
        if (minute.meetingId !== undefined) meetingIdsWithMinute.add(minute.meetingId);
      }
    }
    for (const meeting of meetings) {
      if (
        meeting.minuteToken !== undefined ||
        meeting.noteId === undefined ||
        meetingIdsWithMinute.has(meeting.meetingId)
      ) continue;
      artifacts.push(noteArtifact(meeting));
    }
    return { artifacts: stableArtifacts(artifacts), nextCursor: throughCursor };
  };

  const collect = async (
    inputCursor: string | null,
    lastSuccessfulObservationAt: number | null | undefined,
    signal: AbortSignal,
  ): Promise<{ readonly artifacts: FeishuGeneratedArtifact[]; readonly nextCursor: string }> => {
    const currentTime = now();
    const end = Math.max(0, currentTime - searchConsistencyLagMs);
    const boundary = catchUpBoundary(inputCursor, lastSuccessfulObservationAt, currentTime);
    if (boundary !== undefined && end - boundary.timestamp > maxAutomaticCatchUpMs) {
      throw new FeishuCatchUpRequiredError({
        fromCursor: boundary.cursor,
        throughCursor: cursor(end),
        reason: 'CURSOR_GAP',
      });
    }
    return collectWindow(inputCursor, end, currentTime, signal);
  };

  return {
    start,
    async detectCatchUpRequirement({ cursor: inputCursor, lastSuccessfulObservationAt }) {
      const currentTime = now();
      const end = Math.max(0, currentTime - searchConsistencyLagMs);
      const boundary = catchUpBoundary(inputCursor, lastSuccessfulObservationAt, currentTime);
      if (boundary !== undefined && end - boundary.timestamp > maxAutomaticCatchUpMs) {
        throw new FeishuCatchUpRequiredError({
          fromCursor: boundary.cursor,
          throughCursor: cursor(end),
          reason: 'CURSOR_GAP',
        });
      }
    },
    async listGeneratedArtifacts({
      cursor: inputCursor,
      lastSuccessfulObservationAt,
      limit,
      signal,
    }): Promise<FeishuGeneratedArtifactPage> {
      if (!Number.isInteger(limit) || limit < 1 || limit > 64) {
        throw new TypeError('generated-artifact page limit must be 1..64');
      }
      await start();
      const activeSignal = AbortSignal.any([signal, lifecycle.signal]);
      if (buffered.length === 0) {
        const result = await collect(inputCursor, lastSuccessfulObservationAt, activeSignal);
        buffered = result.artifacts;
        bufferedInputCursor = inputCursor;
        bufferedNextCursor = result.nextCursor;
        if (buffered.length === 0) {
          await sleep(pollIntervalMs, activeSignal);
          return { artifacts: [], nextCursor: result.nextCursor };
        }
      } else if (inputCursor !== bufferedInputCursor) {
        return unavailable('Feishu polling page cursor changed while buffered');
      }
      const artifacts = buffered.splice(0, limit);
      const nextCursor = buffered.length === 0 ? bufferedNextCursor : bufferedInputCursor;
      if (buffered.length === 0) {
        bufferedInputCursor = null;
        bufferedNextCursor = null;
      }
      return { artifacts, nextCursor };
    },
    inspectArtifact(locator, signal): Promise<unknown> {
      return inspectArtifact(locator, signal);
    },
    async scanGeneratedArtifacts({ fromCursor, throughCursor, signal }) {
      await start();
      const currentTime = now();
      if (!throughCursor.startsWith(CURSOR_PREFIX)) {
        return unavailable('Feishu catch-up boundary is malformed');
      }
      const end = Number(throughCursor.slice(CURSOR_PREFIX.length));
      if (!Number.isSafeInteger(end) || end < 0 || end > currentTime) {
        return unavailable('Feishu catch-up boundary is malformed');
      }
      return collectWindow(fromCursor, end, currentTime, AbortSignal.any([signal, lifecycle.signal]));
    },
    async close(): Promise<void> {
      lifecycle.abort(new Error('Feishu polling gateway closed'));
      await starting?.catch(() => undefined);
    },
  };
}
