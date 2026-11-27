import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { MemoryDescriptor, SearchResultDto } from '@clowder-ai/plugin-memory-contract';

import { createMemoryPluginModule } from '../dist/plugin-entrypoint.js';
import type { MemoryEmbeddingPort } from '../src/host-port.js';
import { fakeKv, FIXTURE_MODEL, host, manifest, seedEvidenceDatabase, VECTOR_ONLY_ANCHOR } from './host-fixture.js';

/** The actions the Host invokes; bound here so the assertions stay typed. */
interface MemoryActions {
  'memory.describe': (input: unknown) => Promise<MemoryDescriptor>;
  'memory.dispatch': (input: unknown) => Promise<unknown>;
}

async function withPlugin(
  run: (actions: MemoryActions) => Promise<void>,
  { withVectors = false, embedding }: { withVectors?: boolean; embedding?: MemoryEmbeddingPort } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'memory-search-'));
  const canonicalPath = join(root, 'evidence.sqlite');
  seedEvidenceDatabase(canonicalPath, withVectors);
  const activation = (await createMemoryPluginModule()
    .create(manifest)
    .start(host(fakeKv().port, canonicalPath, root, embedding))) as unknown as {
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
    assert.equal(result.degradeReason, 'passage_embedding_unavailable');
    assert.ok(result.hits.length >= 1, 'the lexical fallback still answers');
  });
});

test('an invalid query is rejected at the boundary without touching the database', async () => {
  await withPlugin(async (actions) => {
    await assert.rejects(search(actions, { query: '' }), /query/);
    await assert.rejects(search(actions, { query: 'q', options: { authorizedCollections: ['secret'] } }), /authorizedCollections/);
    await assert.rejects(search(actions, { query: 'q', options: { contextWindow: 6 } }), /contextWindow/);
  });
});

test('raw search returns the matched passage and only neighbours inside the date window', async () => {
  await withPlugin(async (actions) => {
    const query = 'Chrysanthemum migration detail';
    const result = await search(actions, {
      query,
      options: { depth: 'raw', contextWindow: 1, dateTo: '2026-11-19T02:20:00.000Z' },
    });
    assert.equal(result.degraded, false);
    const [hit] = result.hits;
    assert.equal(hit?.anchor, 'test:legacy-fixture-v0141');
    assert.deepEqual(hit?.passages?.map(({ passageId }) => passageId), ['p2']);
    assert.equal(hit?.passages?.[0]?.content, 'Chrysanthemum migration detail in the middle');
    assert.deepEqual(hit?.passages?.[0]?.context?.map(({ passageId }) => passageId), ['p1']);
    assert.deepEqual((await search(actions, {
      query,
      options: { depth: 'raw', contextWindow: 1, threadId: 'absent' },
    })).hits, []);
  });
});

test('pull-only rows are absent from ordinary recall and available to an explicit pull', async () => {
  await withPlugin(async (actions) => {
    for (const depth of ['summary', 'raw'] as const) {
      const options = { depth };
      assert.deepEqual((await search(actions, { query: 'SealedMaterial', options })).hits, []);
      const pulled = await search(actions, { query: 'SealedMaterial', options: { ...options, includePullOnly: true } });
      assert.deepEqual(pulled.hits.map(({ anchor }) => anchor), ['test:pull-only']);
    }
  });
});

const embedding: MemoryEmbeddingPort = {
  embedQuery: async () => ({ model: FIXTURE_MODEL, vector: [1, 0, 0, 0] }),
};

test('semantic search reaches an actual vec0 neighbour with no lexical match', async () => {
  await withPlugin(async (actions) => {
    const query = 'security roster';
    assert.deepEqual((await search(actions, { query })).hits, []);
    for (const depth of ['summary', 'raw'] as const) {
      const result = await search(actions, { query, options: { depth, mode: 'semantic', limit: 1 } });
      assert.equal(result.degraded, false);
      assert.deepEqual(result.hits.map(({ anchor }) => anchor), [VECTOR_ONLY_ANCHOR]);
      if (depth === 'raw') assert.equal(result.hits[0]?.passages?.[0]?.content, 'Night watch rotation schedule');
    }
  }, { withVectors: true, embedding });
});

test('hybrid search combines lexical and vector hits without admitting pull-only rows', async () => {
  await withPlugin(async (actions) => {
    for (const depth of ['summary', 'raw'] as const) {
      const result = await search(actions, {
        query: 'Chrysanthemum migration detail',
        options: { depth, mode: 'hybrid', limit: 2 },
      });
      assert.equal(result.degraded, false);
      assert.deepEqual(result.hits.map(({ anchor }) => anchor), ['test:legacy-fixture-v0141', VECTOR_ONLY_ANCHOR]);
    }
  }, { withVectors: true, embedding });
});

test('a missing vector index reports lexical fallback for summary and raw', async () => {
  await withPlugin(async (actions) => {
    const query = 'Chrysanthemum migration detail';
    for (const depth of ['summary', 'raw'] as const) {
      const options = { depth, limit: 1 };
      const lexical = await search(actions, { query, options });
      const result = await search(actions, { query, options: { ...options, mode: 'hybrid' } });
      assert.equal(result.degraded, true);
      assert.equal(result.effectiveMode, 'lexical');
      assert.equal(result.degradeReason, 'passage_vector_search_error');
      assert.deepEqual(result.hits, lexical.hits);
    }
  }, { embedding });
});

test('a missing evidence database fails at activation instead of answering "no hits"', async () => {
  await assert.rejects(
    createMemoryPluginModule()
      .create(manifest)
      .start(host(fakeKv().port, join(tmpdir(), 'definitely-absent', 'evidence.sqlite'))),
    /directory does not exist|unable to open|fileMustExist/i,
  );
});
