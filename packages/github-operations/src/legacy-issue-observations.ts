import { createHash } from 'node:crypto';
import { decodeLegacyIssueObservation, type SdkCommunityIssueStore } from './business/domains/community/CommunityIssueStore.js';

const legacyFields = new Set(['id', 'repo', 'issueNumber', 'issueType', 'title', 'state', 'replyState', 'consensusState',
  'assignedThreadId', 'assignedCatId', 'linkedPrNumbers', 'directionCard', 'ownerDecision', 'relatedFeature',
  'guardianAssignment', 'routeAcceptance', 'routeSource', 'lastActivityAt', 'lastActivityEvent', 'createdAt', 'updatedAt']);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('legacy copy requires objects');
  return value as Record<string, unknown>;
}
const rawObject = (value: Record<string, string>) => '{' + Object.keys(value).sort()
  .map(key => JSON.stringify(key) + ':' + JSON.stringify(value[key])).join(',') + '}';

/** Fixed top-level `issues`; raw record IDs and raw field names use JS UTF-16
 * ordering. String values remain byte-for-byte JSON strings, never normalized.
 * Digest proves transport consistency, NOT authenticated origin or ownership. */
export function legacyIssueSnapshotBytes(issues: Record<string, Record<string, string>>): string {
  return '{"issues":{' + Object.keys(issues).sort().map(id => JSON.stringify(id) + ':' + rawObject(issues[id]!)).join(',') + '}}';
}

function decode(value: unknown) {
  const envelope = object(value);
  if (Object.keys(envelope).some(key => !['protocolVersion', 'sourceDigest', 'snapshot'].includes(key)) ||
    envelope.protocolVersion !== 1 || typeof envelope.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.sourceDigest)) {
    throw new TypeError('invalid legacy issue copy envelope');
  }
  if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > 256 * 1024) throw new TypeError('legacy copy exceeds 256 KiB');
  const snapshot = object(envelope.snapshot);
  if (Object.keys(snapshot).length !== 1 || !Object.hasOwn(snapshot, 'issues')) throw new TypeError('unsupported legacy snapshot');
  const issues = object(snapshot.issues);
  if (Object.keys(issues).length > 500) throw new TypeError('legacy copy exceeds 500 records');
  const rawIssues: Record<string, Record<string, string>> = Object.create(null);
  const subjects = new Set<string>();
  const observations = Object.keys(issues).sort().map(id => {
    if (!id.trim() || id.length > 256) throw new TypeError('invalid legacy record ID');
    const raw = object(issues[id]);
    if (raw.id !== id || Object.entries(raw).some(([key, value]) => !legacyFields.has(key) || typeof value !== 'string')) {
      throw new TypeError('invalid legacy raw hash');
    }
    const hash = raw as Record<string, string>;
    rawIssues[id] = hash;
    const result = decodeLegacyIssueObservation(hash);
    if (subjects.has(result.id)) throw new TypeError('duplicate legacy issue subject');
    subjects.add(result.id);
    return result;
  });
  const digest = createHash('sha256').update(legacyIssueSnapshotBytes(rawIssues), 'utf8').digest('hex');
  if (digest !== envelope.sourceDigest) throw new TypeError('legacy snapshot digest mismatch');
  return { digest, observations };
}

/** The owner-local generic operation supplies raw hashes. All decoding is in
 * the package. Validate the whole bounded batch before the first insertion.
 * Partial failures are retryable; CAS preserves every already existing record. */
export async function copyLegacyIssueObservations(value: unknown, store: SdkCommunityIssueStore, signal: AbortSignal) {
  const { digest, observations } = decode(value);
  const counts = { imported: 0, identical: 0, preserved: 0 };
  for (const observation of observations) {
    signal.throwIfAborted();
    counts[await store.copyObservation(observation)]++;
  }
  return { render: 'status' as const, data: {
    protocolVersion: 1, sourceDigest: digest, ...counts, recordCount: observations.length,
    scope: 'provider-metadata-only', hostGovernanceRetained: true, trackingStarted: false,
  } };
}

/** Stored configuration is merged into params.input by the existing operation
 * carrier. Only the three protocol fields belong to the import/digest. */
export function legacyIssueOperationInput(value: unknown) {
  const input = object(object(value).input);
  return { protocolVersion: input.protocolVersion, sourceDigest: input.sourceDigest, snapshot: input.snapshot };
}
