import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

test('first classification partitions the observed corpus, keeps Feature provenance and never implies acceptance', () => {
  const batch = JSON.parse(readFileSync(new URL('../data/first-classification.v1.json', import.meta.url)));
  const corpus = batch.catalog.issues;
  assert.equal(new Set(corpus.map(i => i.id)).size, corpus.length);
  assert.equal(new Set(corpus.map(i => i.number)).size, corpus.length);
  assert.equal(corpus.length, batch.catalog.total);
  assert.equal(corpus.filter(i => i.state === 'OPEN').length, batch.catalog.open);
  assert.equal(corpus.filter(i => i.state === 'CLOSED').length, batch.catalog.closed);
  const canonical = JSON.stringify(corpus.map(i => Object.fromEntries(Object.entries(i).sort(([a], [b]) => a.localeCompare(b, 'en')))));
  assert.equal(createHash('sha256').update(canonical).digest('hex'), batch.catalog.snapshotSha256);
  const bound = corpus.filter(i => i.labels.some(l => /^feature:F\d+$/i.test(l)));
  const free = corpus.filter(i => !bound.includes(i));
  assert.equal(bound.length, batch.catalog.featureBound);
  assert.deepEqual(new Set(batch.suggestions.map(i => i.source.issueId)), new Set(free.map(i => i.id)));
  assert.equal(batch.suggestions.length, free.length, 'exactly one proposal for each unbound issue');
  const counts = {};
  for (const suggestion of batch.suggestions) {
    const fact = free.find(i => i.id === suggestion.source.issueId);
    assert.ok(fact);
    assert.equal(suggestion.source.number, fact.number);
    assert.equal(suggestion.source.repositoryId, batch.catalog.repositoryId);
    assert.equal(suggestion.source.bodySha256, fact.bodySha256);
    assert.equal(suggestion.source.updatedAt, fact.updatedAt);
    assert.equal(suggestion.evidence.excerpt, fact.title);
    assert.equal(suggestion.labels.area.length, 1, 'primary categories partition the corpus');
    for (const [facet, labels] of Object.entries(suggestion.labels))
      for (const id of labels) assert.ok(batch.taxonomy[facet][id], `unknown ${facet}:${id}`);
    const area = suggestion.labels.area[0];
    counts[area] = (counts[area] ?? 0) + 1;
    assert.equal(suggestion.status, 'proposed');
    assert.equal(suggestion.humanAcceptance, null);
  }
  assert.deepEqual(counts, batch.areaCounts);
  assert.equal(batch.method.accuracyMeasured, false);
  assert.equal(batch.method.trainedModel, false);
});
