import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FeatureContext, PluginActionContext, PluginStorageHost } from '@clowder-ai/plugin-sdk';
import { WAIT_PREFIX } from './typed-wait-record.js';
import { collectionPrefix } from './community-collection-record.js';
import { MIGRATED_ISSUES } from './migrated-issue-record.js';
import { JOURNAL_HEAD, SUBJECTS } from './business/domains/community/journal-directory.js';
import { object, projectStatus, statusMetadata, type StatusSource } from './tracking-status-projection.js';

const inputSchema = z.object({
  view: z.enum(['tracking', 'recovery', 'diagnostics']).default('tracking'),
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200).transform(s => s.toLowerCase()).optional(),
  catId: z.string().trim().min(1).max(200).optional(),
  threadId: z.string().trim().min(1).max(200).optional(),
  needsAttention: z.boolean().default(false), limit: z.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(4096).optional(),
}).strict();
const cursorSchema = z.object({ v: z.literal(1), query: z.string(), source: z.number().int().min(0).max(3),
  scan: z.string().regex(/^(0|[1-9]\d{0,19})$/), after: z.string().max(1024).optional() }).strict();
type Position = z.infer<typeof cursorSchema>;
const prefixes: Record<StatusSource, string> = { typed: WAIT_PREFIX, collection: collectionPrefix,
  migratedIssues: MIGRATED_ISSUES, journal: SUBJECTS, diagnostics: 'github.tracking-diagnostics.v1.' };
const MAX_SCAN_CALLS = 8, MAX_EXAMINED = 500, MAX_DATA_BYTES = 60_000;

/** A live read page. Cursors locate a source/scan page/key, never retain records or authorize writes. */
export async function listTrackingStatus(storage: PluginStorageHost, secrets: FeatureContext['secrets'], value: unknown,
  caller?: PluginActionContext) {
  const { cursor, ...query } = inputSchema.parse(value ?? {});
  const sources: StatusSource[] = query.view === 'tracking' ? ['typed', 'migratedIssues']
    : query.view === 'recovery' ? ['typed', 'collection', 'migratedIssues', 'journal'] : ['diagnostics'];
  const digest = createHash('sha256').update(JSON.stringify({ ...query, userId: caller?.userId ?? null })).digest('hex');
  let position: Position = { v: 1, query: digest, source: 0, scan: '0' };
  if (cursor) {
    try {
      position = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
      const prefix = prefixes[sources[position.source]!];
      if (position.query !== digest || !prefix || position.after && !position.after.startsWith(prefix)) throw new Error();
    } catch { throw new TypeError('Invalid tracking cursor or changed query; restart without cursor'); }
  }
  if (!storage.scan) throw new Error('Host plugin storage pagination is unavailable; update the Host before using this plugin');
  await caller?.assertCurrent();
  const data = { tracking: [] as Record<string, unknown>[], diagnostics: [] as Record<string, unknown>[],
    recoveryOwners: { typed: [] as Record<string, unknown>[], collection: [] as Record<string, unknown>[],
      migratedIssues: [] as Record<string, unknown>[], journal: { readiness: 'not_inspected', entries: [] as Record<string, unknown>[] } } };
  let scanCalls = 0, examined = 0, returned = 0, unattributed = 0, dataBytes = 0;
  const finish = async (stopReason: 'complete' | 'limit' | 'byte_budget' | 'scan_budget') => {
    await caller?.assertCurrent();
    const nextCursor = position.source < sources.length ? Buffer.from(JSON.stringify(position)).toString('base64url') : null;
    return { data: { ...data, page: { view: query.view, limit: query.limit, returned,
      hasMore: nextCursor !== null, nextCursor, remaining: null, stopReason, scanCalls, examined, unattributed,
      consistency: 'live', detail: 'bounded_status', maxResponseBytes: 65_536 } } };
  };
  const advance = (next: string) => { position = next === '0'
    ? { ...position, source: position.source + 1, scan: '0', after: undefined }
    : { ...position, scan: next, after: undefined }; };
  while (position.source < sources.length) {
    if (scanCalls >= MAX_SCAN_CALLS || examined >= MAX_EXAMINED) return finish('scan_budget');
    await caller?.assertCurrent();
    const source = sources[position.source]!, prefix = prefixes[source];
    if (source === 'journal') {
      const control = object((await storage.get(JOURNAL_HEAD))?.value);
      data.recoveryOwners.journal.readiness = object(control.directory).status === 'ready' ? 'ready' : 'not_ready';
    }
    const page = await storage.scan({ prefix, cursor: position.scan, count: 50 }); scanCalls++;
    // COUNT is a hint. Re-read the same scan page after the last processed key when its tail did not fit.
    const keys = Object.keys(page.entries).filter(key => key.startsWith(prefix) && (!position.after || key > position.after)).sort();
    for (const key of keys) {
      if (examined >= MAX_EXAMINED) return finish('scan_budget');
      examined++;
      const entry = page.entries[key]!, meta = await statusMetadata(storage, source, entry.value);
      if (caller?.userId && typeof meta.userId === 'string' && meta.userId !== caller.userId) { position.after = key; continue; }
      const missing = query.repo && typeof meta.subject !== 'string' || query.catId && typeof meta.catId !== 'string'
        || query.threadId && typeof meta.threadId !== 'string';
      if (missing) { unattributed++; position.after = key; continue; }
      const repo = typeof meta.subject === 'string' ? meta.subject.toLowerCase().match(/^(?:pr|issue):([^#]+)#/)?.[1] : undefined;
      if (query.repo && repo !== query.repo ||
        query.catId && meta.catId !== query.catId || query.threadId && meta.threadId !== query.threadId ||
        query.needsAttention && !meta.needsAttention) { position.after = key; continue; }
      if (returned >= query.limit) return finish('limit');
      const item = await projectStatus(source, key, entry, secrets);
      const size = Buffer.byteLength(JSON.stringify(item));
      if (dataBytes + size > MAX_DATA_BYTES) return finish('byte_budget');
      if (item.tracking) data.tracking.push(item.tracking);
      if (item.diagnostic) data.diagnostics.push(item.diagnostic);
      if (item.recovery) {
        if (source === 'journal') data.recoveryOwners.journal.entries.push(item.recovery);
        else if (source !== 'diagnostics') data.recoveryOwners[source].push(item.recovery);
      }
      returned++; dataBytes += size; position.after = key;
    }
    advance(page.cursor);
  }
  return finish('complete');
}
