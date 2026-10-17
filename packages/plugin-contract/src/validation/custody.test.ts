import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCustodyContract } from './custody.js';
const sha = 'a'.repeat(40), digest = 'b'.repeat(64);
const predicate = { kind: 'review_delivered', subjectRef: 'pr:org/repo#1', identityKey: 'review_delivered\u001fpr:org/repo#1', freshnessKey: `head:${sha}`, digest, headSha: sha };
test('custody wire accepts canonical input and rejects authority-bearing additions', () => {
  const preflight = { leaseId: 'lease', generation: 1, terminalPredicateDigest: digest };
  const complete = { leaseId: 'lease', generation: 1, evidenceRefs: ['github:exact'] };
  assertCustodyContract('CustodyPreflightInput', preflight);
  assertCustodyContract('CustodyCompleteInput', complete);
  for (const field of ['catId', 'threadId', 'userId', 'now', 'verified', 'binding', 'callback']) {
    assert.throws(() => assertCustodyContract('CustodyPreflightInput', { ...preflight, [field]: 'forged' }));
    assert.throws(() => assertCustodyContract('CustodyCompleteInput', { ...complete, [field]: 'forged' }));
  }
  assert.throws(() => assertCustodyContract('CustodyPreflightResult', { ok: true, reason: 'unknown' }));
});
test('verifier result requires standing and cannot choose tenant or candidate binding', () => {
  const result = { status: 'verified', evidenceRef: 'provider:1', freshnessKey: predicate.freshnessKey, ownerCatId: 'cat', holderThreadId: 'thread' };
  assertCustodyContract('PredicateFreshnessResult', result);
  const { ownerCatId: _, ...missing } = result;
  assert.throws(() => assertCustodyContract('PredicateFreshnessResult', missing));
  for (const field of ['tenantScope', 'approvedDelegates', 'candidateRevision', 'evidenceDigest', 'committed']) {
    assert.throws(() => assertCustodyContract('PredicateFreshnessResult', { ...result, [field]: 'forged' }));
  }
  assertCustodyContract('PredicateFreshnessInput', { actionFamily: 'review', subjectRef: predicate.subjectRef, predicate });
  assert.throws(() => assertCustodyContract('PredicateFreshnessInput', { actionFamily: 'review', subjectRef: 'pr:other/repo#2', predicate }));
});
