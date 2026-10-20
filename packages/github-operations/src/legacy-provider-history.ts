import { createHash } from 'node:crypto';
import type { PluginStorageHost } from '@clowder-ai/plugin-sdk';

const providerKinds = new Set(['issue.opened', 'issue.closed', 'issue.reopened', 'issue.commented', 'issue.labeled',
  'pr.opened', 'pr.ready_for_review', 'pr.merged', 'pr.closed', 'pr.review_submitted']);
const hostKinds = new Set(['case.triaged', 'case.routed', 'case.reported', 'case.waived', 'case.declined',
  'case.awaiting_external', 'case.fix_evidence_recorded', 'case.external_review_assigned', 'case.head_observed',
  'case.ci_observed', 'case.cloud_review_observed', 'case.review_ready', 'case.reviewer_wake_delivered',
  'case.review_verdict_submitted', 'case.review_verdict_recorded', 'case.route_validated', 'case.route_rejected',
  'case.route_decision_eval', 'case.bootstrap']);
const classifications = new Set(['state-changing', 'needs-human', 'needs-owner', 'informational', 'stale']);
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const key = (subject: string) => `github.legacy-provider-history.${hash(subject)}`;
type Fact = { kind: string; at: number; sourceSequence: number; sourceFingerprint: string };
type History = { subjectKey: string; sourceDigest: string; sourceCount: number; hostEventsRetained: number; items: Fact[] };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('history requires an object');
  return value as Record<string, unknown>;
}
function subject(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256 ||
    !/^(?:pr|issue):[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/.test(value) ||
    !Number.isSafeInteger(Number(value.slice(value.lastIndexOf('#') + 1)))) throw new TypeError('invalid history subject');
  return value;
}
function fields(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(k => !allowed.includes(k))) throw new TypeError('unsupported history field');
}
const safeCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Raw Redis LIST elements stay strings and retain insertion order. Only subject
 * keys are sorted (JS UTF-16). The digest proves transport integrity, not authority. */
export function legacyHistoryBytes(events: Record<string, string[]>): string {
  return '{"events":{' + Object.keys(events).sort().map(s => JSON.stringify(s) + ':' + JSON.stringify(events[s])).join(',') + '}}';
}

function decode(value: unknown): { digest: string; histories: History[] } {
  const input = object(value); fields(input, ['protocolVersion', 'sourceDigest', 'snapshot']);
  if (input.protocolVersion !== 1 || typeof input.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.sourceDigest)) {
    throw new TypeError('invalid history envelope');
  }
  if (Buffer.byteLength(JSON.stringify(input)) > 256 * 1024) throw new TypeError('history exceeds 256 KiB');
  const snapshot = object(input.snapshot); fields(snapshot, ['events']);
  const events = object(snapshot.events);
  if (Object.keys(events).length > 50) throw new TypeError('history exceeds 50 subjects');
  let total = 0;
  const ids = new Set<string>();
  const identities = new Set<string>();
  const raws: Record<string, string[]> = Object.create(null);
  const histories = Object.keys(events).sort().map(s => {
    const identity = subject(s).toLowerCase();
    if (identities.has(identity)) throw new TypeError('duplicate canonical history subject');
    identities.add(identity);
    const list = events[s];
    if (!Array.isArray(list) || list.some(v => typeof v !== 'string')) throw new TypeError('history requires raw LIST strings');
    total += list.length;
    if (total > 500) throw new TypeError('history exceeds 500 events');
    raws[s] = list;
    const items: Fact[] = [];
    let hostEventsRetained = 0;
    for (const [sourceSequence, raw] of list.entries()) {
      const event = object(JSON.parse(raw));
      fields(event, ['sourceEventId', 'subjectKey', 'kind', 'classification', 'payload', 'at']);
      if (event.subjectKey !== s || typeof event.sourceEventId !== 'string' || !event.sourceEventId.trim() ||
        event.sourceEventId.length > 512 || !safeCount(event.at) || typeof event.kind !== 'string' ||
        typeof event.classification !== 'string' || !classifications.has(event.classification)) throw new TypeError('invalid raw history event');
      object(event.payload);
      if (ids.has(event.sourceEventId)) throw new TypeError('duplicate history source event');
      ids.add(event.sourceEventId);
      if (hostKinds.has(event.kind)) { hostEventsRetained++; continue; }
      if (!providerKinds.has(event.kind) || (event.kind.startsWith('pr.') && !s.startsWith('pr:')) ||
        (event.kind.startsWith('issue.') && !s.startsWith('issue:'))) throw new TypeError('unsupported provider history kind');
      // Do not persist payload, classification or raw IDs: they can contain
      // private text and Host principals even when the outer kind is external.
      items.push({ kind: event.kind, at: event.at, sourceSequence, sourceFingerprint: hash(raw) });
    }
    return { subjectKey: s, sourceDigest: hash(JSON.stringify(list)), sourceCount: list.length, hostEventsRetained, items };
  });
  if (hash(legacyHistoryBytes(raws)) !== input.sourceDigest) throw new TypeError('history digest mismatch');
  // Verify exact legacy keys, event subjects and raw bytes before projecting
  // storage identities. Never combine logs that alias within one snapshot.
  return { digest: input.sourceDigest, histories: histories.map(history => ({ ...history, subjectKey: history.subjectKey.toLowerCase() })) };
}

/** One atomic inert row per subject. Never writes the active event log,
 * projections, registrations, collection cursors or notification dedup keys. */
export async function copyLegacyProviderHistory(value: unknown, storage: PluginStorageHost, signal: AbortSignal) {
  const { digest, histories } = decode(value);
  const counts = { imported: 0, identical: 0, preserved: 0, hostEventsRetained: 0 };
  for (const history of histories) {
    signal.throwIfAborted();
    counts.hostEventsRetained += history.hostEventsRetained;
    const result = await storage.compareAndSet(key(history.subjectKey), null, history);
    if (result.applied) { counts.imported++; continue; }
    const existing = await storage.get(key(history.subjectKey));
    if (JSON.stringify(existing?.value) === JSON.stringify(history)) counts.identical++;
    else counts.preserved++;
  }
  return { render: 'status' as const, data: { protocolVersion: 1, sourceDigest: digest, ...counts,
    scope: 'historical-provider-metadata-only', currentStateAffected: false, trackingStarted: false } };
}

function readHistory(value: unknown, expected: string): History {
  const row = object(value); fields(row, ['subjectKey', 'sourceDigest', 'sourceCount', 'hostEventsRetained', 'items']);
  if (row.subjectKey !== expected || typeof row.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(row.sourceDigest) ||
    !safeCount(row.sourceCount) || row.sourceCount > 500 || !safeCount(row.hostEventsRetained) ||
    !Array.isArray(row.items) || row.items.length + row.hostEventsRetained !== row.sourceCount) throw new TypeError('invalid stored history');
  let prior = -1;
  for (const item of row.items) {
    const fact = object(item); fields(fact, ['kind', 'at', 'sourceSequence', 'sourceFingerprint']);
    if (typeof fact.kind !== 'string' || !providerKinds.has(fact.kind) || !safeCount(fact.at) ||
      !safeCount(fact.sourceSequence) || fact.sourceSequence <= prior || fact.sourceSequence >= row.sourceCount ||
      typeof fact.sourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fact.sourceFingerprint)) throw new TypeError('invalid stored history fact');
    prior = fact.sourceSequence;
  }
  return row as History;
}

export async function inspectLegacyProviderHistory(value: unknown, storage: PluginStorageHost) {
  const input = object(value); fields(input, ['subjectKey', 'offset', 'limit']);
  const s = subject(input.subjectKey).toLowerCase(), offset = input.offset ?? 0, limit = input.limit ?? 50;
  if (!safeCount(offset) || !safeCount(limit) || limit < 1 || limit > 100) throw new TypeError('invalid history pagination');
  const entry = await storage.get(key(s));
  const history = entry ? readHistory(entry.value, s) : null;
  const items = history?.items ?? [];
  const [kind, rest] = s.split(':') as [string, string];
  const [repo, number] = rest.split('#');
  return { data: { subjectKey: s, url: `https://github.com/${repo}/${kind === 'pr' ? 'pull' : 'issues'}/${number}`,
    sourceDigest: history?.sourceDigest ?? null, hostEventsRetained: history?.hostEventsRetained ?? 0,
    items: items.slice(offset, offset + limit), nextOffset: items.length > offset + limit ? offset + limit : null,
    provenance: 'copied-provider-history-metadata', currentStateAffected: false } };
}
