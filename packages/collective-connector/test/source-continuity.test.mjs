import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const movedHead = '4952f27c9306d34cae35cd44b672803f11ed4f48';
// Semantic edges must remain named for independent review. This guard does not approve them.
const edges = new Map([
  ['contracts/types/collective-work.ts', 'retain only domain standing-work schema; remove generic Host Task/custody validators'],
  ['service/cli.ts', 'retire ambient HOME/env/process-signal lifecycle; SDK module owns activation'],
  ['service/github-app-manifest-setup.ts', 'package-local API result type replaces retained Client import'],
  ['service/http-router.ts', 'retain backend APIs and explicitly reject absent C2 asset routes'],
  ['service/identity-store.ts', 'bind OAuth callback to Host-owned browser-service origin'],
  ['service/store.ts', 'inject protocol label/bootstrap escrow and authenticated same-instance recovery snapshot without polling or writes'],
  ['connector/connector-options.ts', 'inject exact-origin local transport without granting native verifier/control authority'],
  ['connector/connector.ts', 'delegate durable local participation/recovery and guarded publication routing; expose original result-slot artifact staging and fresh Work reads bounded by their connection consumer lifetime'],
  ['connector/connector-synchronization.ts', 'persist four local effect attempts; preserve remote retries; CAS settle and reconcile original intent without blind replay'],
  ['connector/persistence.ts', 'migrate v2 to v3; recover interrupted entered attempts as held unknown; fence stale writers and owner-expired atomic commits'],
  ['connector/projection.ts', 'add bounded held recovery metadata while keeping healthy status shape and omitting private payload/credentials'],
  ['connector/service-client.ts', 'route exact bound origin through private Host dispatch; retain typed effect/retry metadata and original remote fetch'],
  ['connector/work-result-publication.ts', 'describe package capture of the existing UTF8 publication seal; schema and accepted-result projection stay unchanged'],
  ['connector/outbox-custody.ts', 'stage one verified artifact snapshot in the original prepared result slot; preserve exact purpose/author/replay checks and refuse material downgrade'],
  ['connector/state.ts', 'strict v3 durable attempt/participation intent schema with explicit v2 migration; preserve remote sending semantics'],
  ['connector/__tests__/connector-service.test.ts', 'update explicit migrated state version assertion to v3 without removing source business assertions'],
  ['service/__tests__/service-store.test.ts', 'retain original assertions and add actual persisted recovery proof, exact credential/coordinate and no-poll-write checks'],
  ['connector/__tests__/collaboration-proposal.test.ts', 'narrow required source location before typed request'],
  ['connector/__tests__/communication-work-custody.fixture.ts', 'narrow fresh bootstrap credential'],
  ['connector/__tests__/participation-card.test.ts', 'use canonical domain schema defaults in fixture'],
  ['connector/__tests__/reply-operation.test.ts', 'use canonical domain schema defaults in fixture'],
  ['service/__tests__/collaboration-binding-vote.test.ts', 'fix recursive fixture type without changing assertions'],
  ['service/__tests__/github-app-setup-http.test.ts', 'exercise API result instead of retained Client form helper'],
  ['service/__tests__/service-http.test.ts', 'expect explicit C2-unavailable backend response; retain domain API checks'],
]);
function mechanicalImportMove(original, target) {
  const imports = [
    ['@cat-cafe/shared', 'packages/collective-connector/src/business/contracts/index.js'],
    ['@cat-cafe/collective-service', 'packages/collective-connector/src/business/service/index.js'],
    ['../../../collective-service/src/index.js', 'packages/collective-connector/src/business/service/index.js'],
  ];
  for (const [from, destination] of imports) {
    let specifier = relative(dirname(target), destination);
    if (!specifier.startsWith('.')) specifier = './' + specifier;
    for (const quote of ["'", '"']) original = original.replaceAll(quote + from + quote, quote + specifier + quote);
  }
  return original;
}

test('all moved business blobs remain exact or have a named adaptation disposition', async () => {
  const census = JSON.parse(await readFile(join(root, 'migration/collective-source-move.json'), 'utf8'));
  assert.equal(census.sourceCommit, 'ca5b831b48c165ea10c7389fe3eb4ba03d3e01e7');
  assert.equal(census.entries.length, 127);
  const counts = { exact: 0, importOnly: 0, namedEdge: 0 };
  const seen = new Set();
  for (const entry of census.entries) {
    const original = execFileSync('git', ['show', movedHead + ':' + entry.target], { cwd: root });
    assert.equal(createHash('sha256').update(original).digest('hex'), entry.sha256, entry.source);
    const blob = createHash('sha1').update('blob ' + original.length + '\0').update(original).digest('hex');
    assert.equal(blob, entry.sourceBlob, entry.source);
    const edge = entry.target.replace('packages/collective-connector/src/business/', '');
    let current;
    try { current = await readFile(join(root, entry.target), 'utf8'); }
    catch (error) { if (edge !== 'service/cli.ts' || error.code !== 'ENOENT') throw error; }
    if (edges.has(edge)) { counts.namedEdge++; seen.add(edge); continue; }
    if (current === original.toString('utf8')) counts.exact++;
    else {
      assert.equal(current, mechanicalImportMove(original.toString('utf8'), entry.target), 'unclassified semantic delta: ' + edge);
      counts.importOnly++;
    }
  }
  assert.deepEqual([...seen].sort(), [...edges.keys()].sort());
  console.log(JSON.stringify({ sourceCommit: census.sourceCommit, moveCommit: movedHead, entries: census.entries.length, ...counts,
    limitation: 'named semantic edges require independent code review' }));
});
