import { expect, it } from 'vitest';
import { artifactFixture } from './artifact.fixture.js';
import { servers } from './artifact.fixture.js';
import { startCollectiveServer } from '../http-server.js';

it('lets the current Human connect an explicit loopback speech service without allowing arbitrary remote connections', async () => {
  const f = await artifactFixture();
  const response = await fetch(`${f.server.url}/api/health`);
  const policy = response.headers.get('content-security-policy') ?? '';
  const connect = policy.split(';').map(part => part.trim()).find(part => part.startsWith('connect-src '))?.split(/\s+/u).slice(1);
  expect(connect).toContain("'self'");
  expect(connect).toContain('http://127.0.0.1:*');
  expect(connect).not.toContain('*');
  expect(connect).not.toContain('https:');
  expect(policy).toContain("script-src 'self'");
});

it('delegates inline widget scripts with a fresh document nonce without permitting inline scripts throughout the Client', async () => {
  const f = await artifactFixture();
  const bytes = Buffer.from('<!doctype html><html><head></head><body><div id="root"></div></body></html>');
  const server = await startCollectiveServer({ store: f.store, port: 0,
    clientAssets: new Map([['/index.html', { bytes, contentType: 'text/html; charset=utf-8' }]]) });
  servers.push(server);
  const first = await fetch(server.url), second = await fetch(server.url);
  const html = await first.text(), nonce = html.match(/name="collective-widget-nonce" content="([A-Za-z0-9_-]+)"/u)?.[1];
  expect(nonce).toBeTruthy();
  expect(first.headers.get('content-security-policy')).toContain(`'nonce-${nonce}'`);
  expect(first.headers.get('content-security-policy')).not.toContain("'unsafe-inline'");
  expect(await second.text()).not.toBe(html);
  expect(Number(first.headers.get('content-length'))).toBe(Buffer.byteLength(html));
  expect(bytes.toString()).not.toContain('collective-widget-nonce');
});
