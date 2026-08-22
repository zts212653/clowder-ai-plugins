import {
  FeishuGatewayError,
  type FeishuArtifactLocator,
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

const CURSOR_PREFIX = 'poll-v1:';
const DEFAULT_LOOKBACK_MS = 5 * 60_000;
const DEFAULT_OVERLAP_MS = 30_000;
const DEFAULT_SEARCH_CONSISTENCY_LAG_MS = 10 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const SEARCH_PAGE_SIZE = 30;
const MAX_SEARCH_PAGES = 4;
const MAX_CANDIDATES = 64;
const VC_DETAIL_BATCH_SIZE = 50;

export type { LarkCliReadCommand } from './lark-cli-read-command.js';

export interface LarkCliFeishuPollingGateway extends FeishuPollingGateway {
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
  readonly runCommand?: LarkCliReadCommand;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly inspectArtifact?: (
    locator: FeishuArtifactLocator,
    signal: AbortSignal,
  ) => Promise<unknown>;
}

function unavailable(message: string): never {
  throw new FeishuGatewayError('UNAVAILABLE', message);
}

function parseCursor(
  cursor: string | null,
  now: number,
  safeEnd: number,
  lookbackMs: number,
  overlapMs: number,
) {
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

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const onElapsed = (): void => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(onElapsed, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void Promise.resolve().then(() => {
      if (signal.aborted) onAbort();
    });
  });
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
    if (items.length > MAX_CANDIDATES) return unavailable('Feishu polling candidate bound exceeded');
    if (!response.hasMore) return items;
    pageToken = response.pageToken;
  }
  return unavailable('Feishu polling page bound exceeded');
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
  for (const [label, value] of Object.entries({
    lookbackMs,
    overlapMs,
    searchConsistencyLagMs,
    pollIntervalMs,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be positive`);
  }
  const runCommand = options.runCommand ?? createDefaultLarkCliReadCommand(options.homeDirectory);
  const inspectArtifact = options.inspectArtifact ?? createLarkCliFeishuArtifactInspector({
    homeDirectory: options.homeDirectory,
    runCommand,
  });
  const sleep = options.sleep ?? defaultSleep;
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

  const collect = async (
    inputCursor: string | null,
    signal: AbortSignal,
  ): Promise<{ readonly artifacts: FeishuGeneratedArtifact[]; readonly nextCursor: string }> => {
    const currentTime = now();
    const end = Math.max(0, currentTime - searchConsistencyLagMs);
    const begin = parseCursor(inputCursor, currentTime, end, lookbackMs, overlapMs);
    const [owned, participated, meetingItems] = await Promise.all([
      collectSearch(runCommand, 'minutes-owner', begin, end, signal),
      collectSearch(runCommand, 'minutes-participant', begin, end, signal),
      collectSearch(runCommand, 'vc', begin, end, signal),
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
    for (const meeting of meetings) {
      if (meeting.minuteToken !== undefined) {
        minuteTokens.add(meeting.minuteToken);
        meetingByMinute.set(meeting.minuteToken, meeting);
      }
    }
    if (minuteTokens.size + meetings.length > MAX_CANDIDATES) {
      return unavailable('Feishu polling candidate bound exceeded');
    }
    const artifacts: FeishuGeneratedArtifact[] = [];
    for (const token of minuteTokens) {
      artifacts.push(...minuteArtifacts(await runCommand([
        'minutes', 'minutes', 'get', '--minute-token', token,
        '--as', 'user', '--format', 'json',
      ], signal), meetingByMinute.get(token)));
    }
    for (const meeting of meetings) {
      if (meeting.minuteToken !== undefined || meeting.noteId === undefined) continue;
      artifacts.push(noteArtifact(meeting));
    }
    return { artifacts: stableArtifacts(artifacts), nextCursor: cursor(end) };
  };

  return {
    start,
    async listGeneratedArtifacts({ cursor: inputCursor, limit, signal }): Promise<FeishuGeneratedArtifactPage> {
      if (!Number.isInteger(limit) || limit < 1 || limit > 64) {
        throw new TypeError('generated-artifact page limit must be 1..64');
      }
      await start();
      const activeSignal = AbortSignal.any([signal, lifecycle.signal]);
      if (buffered.length === 0) {
        const result = await collect(inputCursor, activeSignal);
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
    async close(): Promise<void> {
      lifecycle.abort(new Error('Feishu polling gateway closed'));
      await starting?.catch(() => undefined);
    },
  };
}
