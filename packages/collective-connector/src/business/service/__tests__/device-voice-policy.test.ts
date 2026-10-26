import { expect, it } from 'vitest';
import { artifactFixture } from './artifact.fixture.js';

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
