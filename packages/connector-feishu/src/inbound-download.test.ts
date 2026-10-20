import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectBoundedInboundMedia,
  fetchBoundedInboundMedia,
  InboundMediaLimitError,
} from './inbound-download.js';

test('bounded inbound collection stops before buffering a chunk beyond the limit', async () => {
  let yielded = 0;
  async function* chunks() {
    yielded += 1;
    yield Buffer.from('1234');
    yielded += 1;
    yield Buffer.from('5');
    yielded += 1;
    yield Buffer.from('must-not-be-read');
  }
  await assert.rejects(collectBoundedInboundMedia(chunks(), 4), InboundMediaLimitError);
  assert.equal(yielded, 2);
});

test('bounded inbound fetch rejects declared oversize content without reading it', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull() {},
    cancel() { cancelled = true; },
  });
  const fetchFn = async () => new Response(body, {
    status: 200,
    headers: { 'content-length': '5' },
  });
  await assert.rejects(
    fetchBoundedInboundMedia(fetchFn as typeof fetch, 'https://media.example/file', {}, 4, 100),
    InboundMediaLimitError,
  );
  assert.equal(cancelled, true);
});

test('bounded inbound fetch aborts a provider request at its deadline', { timeout: 5_000 }, async () => {
  const fetchFn = (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  });
  await assert.rejects(
    fetchBoundedInboundMedia(fetchFn as typeof fetch, 'https://media.example/file', {}, 4, 5),
    /timed out/u,
  );
});

test('bounded inbound fetch cancels an error response body before returning', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull() {},
    cancel() { cancelled = true; },
  });
  const fetchFn = async () => new Response(body, { status: 503 });

  const result = await fetchBoundedInboundMedia(
    fetchFn as typeof fetch,
    'https://media.example/file',
    {},
    4,
    100,
  );

  assert.equal(result.response.status, 503);
  assert.equal(result.bytes.length, 0);
  assert.equal(cancelled, true);
});

test('bounded inbound fetch composes the caller deadline with its own timeout', async () => {
  const controller = new AbortController();
  const fetchFn = (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  });
  const reason = new Error('adapter total budget expired');
  queueMicrotask(() => controller.abort(reason));

  await assert.rejects(
    fetchBoundedInboundMedia(
      fetchFn as typeof fetch,
      'https://media.example/file',
      { signal: controller.signal },
      4,
      100,
    ),
    reason,
  );
});
