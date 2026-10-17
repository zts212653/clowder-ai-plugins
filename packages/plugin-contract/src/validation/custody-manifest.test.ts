import assert from 'node:assert/strict';
import test from 'node:test';
import { validateManifest } from './manifest.js';

function fixture() {
  return { pluginId: 'dev.example.review', version: '1.0.0', contractVersion: '0.1.0', name: 'Review',
    contributions: [{ type: 'terminal-predicate-provider', id: 'review', actionFamily: 'review', predicateKind: 'review_delivered', subjectNamespace: 'pr', freshnessMethod: 'review.freshness', completionMethod: 'review.completion' }],
    features: [{ id: 'review', name: 'Review', resources: [], contributions: [{ type: 'terminal-predicate-provider', id: 'review' }], capabilities: ['custody.verify', 'custody.invoke'] }],
    runtime: { transport: 'builtin', entrypoint: 'dist/index.js' } };
}
test('admits an explicitly owned and authorized builtin predicate provider', () => {
  assert.equal(validateManifest(fixture()).valid, true);
});
test('predicate declarations reject missing grant, unsupported vocabulary/carrier and authority fields', () => {
  for (const mutate of [
    (m: any) => { m.features[0].capabilities = ['custody.invoke']; },
    (m: any) => { m.features[0].contributions = []; },
    (m: any) => { m.contributions[0].predicateKind = 'self_reported_success'; },
    (m: any) => { m.contributions[0].subjectNamespace = 'task'; },
    (m: any) => { delete m.runtime; },
    (m: any) => { m.runtime = { transport: 'stdio', command: 'node', args: [] }; },
    (m: any) => { m.contributions[0].verified = true; },
    (m: any) => { m.contributions[0].completionMethod = m.contributions[0].freshnessMethod; },
  ]) { const m = fixture(); mutate(m); assert.equal(validateManifest(m).valid, false); }
});
test('same selector and verifier/public action collisions fail closed', () => {
  const duplicate = fixture();
  duplicate.contributions.push({ ...duplicate.contributions[0]!, id: 'second', freshnessMethod: 'second.fresh', completionMethod: 'second.complete' });
  duplicate.features[0]!.contributions.push({ type: 'terminal-predicate-provider', id: 'second' });
  assert.equal(validateManifest(duplicate).valid, false);
  const collision: any = fixture();
  collision.contributions.push({ type: 'tool', id: 'leak', name: 'leak', inputSchema: { type: 'object' }, action: { method: 'review.freshness' } });
  collision.features[0].contributions.push({ type: 'tool', id: 'leak' });
  assert.equal(validateManifest(collision).valid, false);
  const global: any = fixture(); global.test = { action: { method: 'review.completion' } };
  assert.equal(validateManifest(global).valid, false);
});
