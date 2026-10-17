import assert from 'node:assert/strict';
import test from 'node:test';
import { assertFrustrationContract } from './frustration.js';
const link = { issueId: 'issue', sourceRevision: 'r1', expectedDraftId: null, draftId: 'draft' };
test('source port rejects raw private context and identity-bearing link input', () => {
  assertFrustrationContract('FrustrationLinkDraftInput', link);
  for (const key of ['userId', 'invocationId', 'cancelled', 'verified', 'now']) assert.throws(() => assertFrustrationContract('FrustrationLinkDraftInput', { ...link, [key]: true }));
  const source = { issueId: 'issue', userId: 'owner', threadId: 'thread', status: 'confirmed', signalType: 'user_report', signalDetail: {}, recentMessageCount: 2, communityIssueDraftId: null, sourceRevision: 'r1' };
  assertFrustrationContract('FrustrationSource', source);
  for (const key of ['context', 'recentMessages', 'errorLogs', 'catId']) assert.throws(() => assertFrustrationContract('FrustrationSource', { ...source, [key]: [] }));
  assert.throws(() => assertFrustrationContract('FrustrationSource', { ...source, signalDetail: { secret: 'private' } }));
  for (const value of [-1, Infinity, NaN]) assert.throws(() => assertFrustrationContract('FrustrationSource', { ...source, recentMessageCount: value }));
  for (const outcome of ['missing', 'not_confirmed', 'stale_source', 'conflict']) assertFrustrationContract('FrustrationLinkDraftResult', { outcome });
  for (const outcome of ['linked', 'already_linked']) assertFrustrationContract('FrustrationLinkDraftResult', { outcome, draftId: 'draft', sourceRevision: 'r1' });
  assert.throws(() => assertFrustrationContract('FrustrationLinkDraftResult', { outcome: 'unknown' }));
  assert.throws(() => assertFrustrationContract('FrustrationLinkDraftResult', { outcome: 'linked' }));
});
