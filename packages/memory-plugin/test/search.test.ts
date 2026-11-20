import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { MemoryDescriptor, SearchResultDto } from '@clowder-ai/plugin-memory-contract';

import { createMemoryPluginModule } from '../src/plugin-entrypoint.js';
import { fakeKv, host, manifest, seedEvidenceDatabase } from './host-fixture.js';

/** The actions the Host invokes; bound here so the assertions stay typed. */
interface MemoryActions {
  'memory.describe': (input: unknown) => Promise<MemoryDescriptor>;
  'memory.dispatch': (input: unknown) => Promise<unknown>;
}

async function withPlugin(run: (actions: MemoryActions) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'memory-search-'));
  const canonicalPath = join(root, 'evidence.sqlite');
  seedEvidenceDatabase(canonicalPath);
  const activation = (await createMemoryPluginModule()
    .create(manifest)
    .start(host(fakeKv().port, { canonicalPath, storageFormat: 1 }))) as unknown as {
    actions: MemoryActions;
    stop?: (input: unknown) => Promise<void>;
  };
  try {
    await run(activation.actions);
  } finally {
    await activation.stop?.({ reason: 'test' });
    await rm(root, { recursive: true, force: true });
  }
}

function search(actions: MemoryActions, input: unknown): Promise<SearchResultDto> {
  return actions['memory.dispatch']({ operation: 'search.query', input }).then(
    (value) => value as SearchResultDto,
  );
}

test('the descriptor advertises retrieval in addition to the kv admission floor', async () => {
  await withPlugin(async (actions) => {
    const descriptor = await actions['memory.describe']({});
    assert.ok(descriptor.operations.includes('search.query'), JSON.stringify(descriptor.operations));
  });
});

test('a lexical query returns ranked hits from the real evidence schema', async () => {
  await withPlugin(async (actions) => {
    const result = await search(actions, { query: 'Chrysanthemum migration witness', options: { limit: 10 } });
    assert.equal(result.query, 'Chrysanthemum migration witness');
    assert.equal(result.degraded, false);
    const witness = result.hits.find((hit) => hit.anchor === 'test:legacy-fixture-v0141');
    assert.ok(witness, JSON.stringify(result.hits.map((hit) => hit.anchor)));
    assert.equal(witness.rank >= 1, true);
    assert.equal(witness.kind, 'lesson');
    assert.equal(witness.title, 'Chrysanthemum v0141 migration witness');
  });
});

test('a superseded record sorts behind the current one for the same match', async () => {
  await withPlugin(async (actions) => {
    const result = await search(actions, { query: 'Chrysanthemum', options: { limit: 10 } });
    const live = result.hits.findIndex((hit) => hit.anchor === 'test:legacy-fixture-v0141');
    const dead = result.hits.findIndex((hit) => hit.anchor === 'test:superseded');
    assert.ok(live >= 0, JSON.stringify(result.hits.map((hit) => hit.anchor)));
    if (dead >= 0) assert.ok(live < dead, 'a superseded record must not outrank the current one');
  });
});

test('an exact anchor is found even though FTS would split it', async () => {
  await withPlugin(async (actions) => {
    const result = await search(actions, { query: 'F042', options: { limit: 5 } });
    assert.ok(
      result.hits.some((hit) => hit.anchor === 'F042'),
      JSON.stringify(result.hits.map((hit) => hit.anchor)),
    );
  });
});

test('a thread filter is a hard result boundary, not a ranking hint', async () => {
  await withPlugin(async (actions) => {
    const result = await search(actions, { query: 'Chrysanthemum', options: { threadId: 'absent' } });
    assert.deepEqual(result.hits, []);
  });
});

test('scope narrows which documents a query may return', async () => {
  await withPlugin(async (actions) => {
    const sessions = await search(actions, { query: 'Chrysanthemum', options: { scope: 'sessions', limit: 10 } });
    assert.deepEqual(sessions.hits, [], 'a lesson is not a session');
  });
});

test('a backstop record never appears as a search hit', async () => {
  await withPlugin(async (actions) => {
    const result = await search(actions, { query: 'Chrysanthemum backstop', options: { limit: 10 } });
    assert.equal(
      result.hits.some((hit) => hit.anchor === 'test:backstop'),
      false,
      'backstop documents exist to be injected, not returned',
    );
  });
});

test('a semantic-only request degrades honestly instead of pretending it ranked semantically', async () => {
  await withPlugin(async (actions) => {
    const result = await search(actions, { query: 'Chrysanthemum migration', options: { mode: 'semantic' } });
    assert.equal(result.degraded, true);
    assert.equal(result.effectiveMode, 'lexical');
    assert.equal(result.degradeReason, 'raw_lexical_only');
    assert.ok(result.hits.length >= 1, 'the lexical fallback still answers');
  });
});

test('an invalid query is rejected at the boundary without touching the database', async () => {
  await withPlugin(async (actions) => {
    await assert.rejects(search(actions, { query: '' }), /query/);
    await assert.rejects(search(actions, { query: 'q', options: { authorizedCollections: ['secret'] } }), /authorizedCollections/);
  });
});

test('a missing evidence database fails loudly instead of answering "no hits"', async () => {
  const activation = (await createMemoryPluginModule()
    .create(manifest)
    .start(
      host(fakeKv().port, {
        canonicalPath: join(tmpdir(), 'definitely-absent', 'evidence.sqlite'),
        storageFormat: 1,
      }),
    )) as unknown as { actions: MemoryActions };
  await assert.rejects(
    search(activation.actions, { query: 'anything' }),
    /cannot read the evidence database/,
  );
});
