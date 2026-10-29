import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { type RunningCollectiveServer, startCollectiveServer } from '../http-server.js';
import { CollectiveServiceStore } from '../store.js';

const script = 'export const greeting = "Welcome to the Collective";\n'.repeat(2_000);
let directory: string;
let server: RunningCollectiveServer;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'collective-static-http-'));
  const { store } = await CollectiveServiceStore.open({ dataDirectory: directory });
  server = await startCollectiveServer({
    store,
    port: 0,
    allowedHostOrigins: ['https://first.cafe.test', 'https://second.cafe.test'],
    clientAssets: new Map([
      ['/index.html', { bytes: Buffer.from('<html><head></head><body>Collective</body></html>'), contentType: 'text/html; charset=utf-8' }],
      ['/collective-client/app.js', { bytes: Buffer.from(script), contentType: 'text/javascript; charset=utf-8' }],
    ]),
  });
});
afterEach(async () => {
  await server?.close();
  await rm(directory, { recursive: true, force: true });
});

it('compresses a verified public script when the browser accepts gzip, preserving the decoded bytes', async () => {
  const response = await fetch(`${server.url}/collective-client/app.js`, { headers: { 'accept-encoding': 'gzip, br' } });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-encoding')).toBe('gzip');
  expect(Number(response.headers.get('content-length'))).toBeLessThan(Buffer.byteLength(script) / 2);
  expect(response.headers.get('vary')?.split(',').map(value => value.trim())).toContain('Accept-Encoding');
  expect(await response.text()).toBe(script);
});

it('revalidates unchanged public assets without retransmitting their bodies', async () => {
  const first = await fetch(`${server.url}/collective-client/app.js`);
  const etag = first.headers.get('etag');
  expect(etag).toBeTruthy();
  expect(first.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
  await first.arrayBuffer();
  const unchanged = await fetch(`${server.url}/collective-client/app.js`, { headers: { 'if-none-match': etag! } });
  expect(unchanged.status).toBe(304);
  expect(await unchanged.text()).toBe('');
  const stale = await fetch(`${server.url}/collective-client/app.js`, { headers: { 'if-none-match': 'W/"old-build"' } });
  expect(stale.status).toBe(200);
  expect(await stale.text()).toBe(script);
});

it('keeps each allowed Host origin separate when a public asset is revalidated', async () => {
  const first = await fetch(`${server.url}/collective-client/app.js`, { headers: { origin: 'https://first.cafe.test' } });
  expect(first.headers.get('access-control-allow-origin')).toBe('https://first.cafe.test');
  expect(first.headers.get('vary')?.split(',').map(value => value.trim())).toContain('Origin');
  await first.arrayBuffer();
  const next = await fetch(`${server.url}/collective-client/app.js`, {
    headers: { origin: 'https://second.cafe.test', 'if-none-match': first.headers.get('etag')! },
  });
  expect(next.status).toBe(304);
  expect(next.headers.get('access-control-allow-origin')).toBe('https://second.cafe.test');
  expect(next.headers.get('vary')?.split(',').map(value => value.trim())).toContain('Origin');
});

it('respects an explicit gzip rejection even when a wildcard accepts other encodings', async () => {
  const response = await fetch(`${server.url}/collective-client/app.js`, {
    headers: { 'accept-encoding': 'gzip;q=0, *;q=1' },
  });
  expect(response.headers.get('content-encoding')).toBeNull();
  expect(await response.text()).toBe(script);
});

it('keeps nonce-bearing HTML and Service JSON outside the public cache', async () => {
  const first = await fetch(server.url);
  const second = await fetch(server.url);
  const firstHtml = await first.text();
  const secondHtml = await second.text();
  expect(first.headers.get('cache-control')).toBe('no-store');
  expect(first.headers.get('etag')).toBeNull();
  expect(firstHtml).toContain('collective-widget-nonce');
  expect(secondHtml).not.toBe(firstHtml);
  const api = await fetch(`${server.url}/api/meta`, { headers: { 'if-none-match': '*' } });
  expect(api.status).toBe(200);
  expect(api.headers.get('cache-control')).toBe('no-store');
  expect(api.headers.get('etag')).toBeNull();
  expect((await api.json()).serviceInstanceId).toBeTruthy();
  const denied = await fetch(`${server.url}/collective-client/app.js`, { headers: { origin: 'https://untrusted.example' } });
  expect(denied.status).toBe(403);
  expect(denied.headers.get('cache-control')).toBe('no-store');
});
