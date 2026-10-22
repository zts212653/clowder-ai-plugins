import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  getAuthStrategy,
  loadProtocolsFromDir,
  poll,
  requireSafeProviderBaseUrl,
  scrubCredentials,
  submit,
} from './protocol-engine/index.js';

const protocolsDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'protocols');

function fixtureTemplate(baseUrl: string) {
  return {
    name: 'fixture',
    version: 1,
    mode: 'async' as const,
    baseUrl,
    capabilities: {
      text2video: {
        submit: {
          method: 'POST' as const,
          path: '/submit',
          response: {
            taskId: '$.id',
            status: '$.status',
            statusMap: { queued: ['queued'] },
          },
        },
        poll: {
          method: 'GET' as const,
          path: '/poll/{{taskId}}',
          interval: 1_000,
          maxAttempts: 2,
          response: {
            status: '$.status',
            statusMap: { succeeded: ['done'] },
            resultUrl: '$.result',
          },
        },
      },
    },
  };
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

test('all package-owned provider templates validate with bounded async polling', () => {
  const templates = loadProtocolsFromDir(protocolsDirectory);
  assert.deepEqual([...templates.keys()].sort(), ['jimeng', 'kling', 'zhipu']);
  for (const [name, template] of templates) {
    assert.equal(template.mode, 'async');
    assert.ok(template.baseUrl?.startsWith('https://'), `${name} has no HTTPS default`);
    const capability = template.capabilities.text2video;
    assert.ok(capability?.submit, `${name} has no text2video submit`);
    assert.ok(capability?.poll, `${name} has no text2video poll`);
    assert.ok(capability.poll.interval >= 1_000);
    assert.ok(capability.poll.maxAttempts >= 1);
  }
});

test('provider endpoints accept HTTP and HTTPS without a loopback-only restriction', () => {
  assert.equal(requireSafeProviderBaseUrl('https://api.example.com/v1'), 'https://api.example.com/v1');
  assert.equal(requireSafeProviderBaseUrl('http://127.0.0.1:43210'), 'http://127.0.0.1:43210/');
  assert.equal(requireSafeProviderBaseUrl('http://api.example.com/v1'), 'http://api.example.com/v1');
  assert.equal(requireSafeProviderBaseUrl('http://192.168.1.20:8080'), 'http://192.168.1.20:8080/');
  assert.throws(() => requireSafeProviderBaseUrl('file:///tmp/provider'), /HTTP or HTTPS/);
  assert.throws(() => requireSafeProviderBaseUrl('https://user:pass@api.example.com'), /must not contain credentials/);
});

test('configured HTTP and HTTPS endpoints reach submit and poll with provider authentication', async (t) => {
  const requests: { url: string; method: string | undefined; authorization: string | null }[] = [];
  // Isolate transport while exercising real URL construction, signing and parsing.
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method, authorization: new Headers(init?.headers).get('authorization') });
    return Response.json(url.endsWith('/submit')
      ? { id: 'task-1', status: 'queued' }
      : { status: 'done', result: 'https://cdn.example/result.mp4' });
  });
  for (const scheme of ['http', 'https']) {
    const baseUrl = `${scheme}://provider.example.com`;
    const params = {
      provider: { id: 'fixture', name: 'fixture', protocol: 'fixture', baseUrl, authType: 'apikey' as const },
      capability: 'text2video', credentials: { apiKey: 'fixture-secret-key' }, vars: { prompt: 'hello' },
    };
    assert.deepEqual(await submit(fixtureTemplate(baseUrl), params), { taskId: 'task-1', status: 'queued' });
    assert.deepEqual(await poll(fixtureTemplate(baseUrl), params, 'task-1'), {
      status: 'succeeded', resultUrl: 'https://cdn.example/result.mp4',
    });
  }
  assert.deepEqual(requests, ['http', 'https'].flatMap(scheme => [
    { url: `${scheme}://provider.example.com/submit`, method: 'POST', authorization: 'Bearer fixture-secret-key' },
    { url: `${scheme}://provider.example.com/poll/task-1`, method: 'GET', authorization: 'Bearer fixture-secret-key' },
  ]));
});

test('every authentication strategy rejects missing required credentials', () => {
  assert.throws(() => getAuthStrategy('apikey').sign({}, { method: 'POST', url: 'https://api.example.com' }), /apiKey/);
  assert.throws(() => getAuthStrategy('query-param').sign({}, { method: 'POST', url: 'https://api.example.com' }), /apiKey/);
  assert.throws(() => getAuthStrategy('jwt-hs256').sign({}, { method: 'POST', url: 'https://api.example.com' }), /accessKey/);
  assert.throws(() => getAuthStrategy('hmac-sha256-v4').sign({ accessKey: 'ak' }, { method: 'POST', url: 'https://api.example.com' }), /secretKey/);
});

test('submit and poll execute against an isolated provider fixture without leaking credentials', async () => {
  const seenAuthorization: string[] = [];
  const server = createServer((request, response) => {
    seenAuthorization.push(String(request.headers.authorization));
    response.setHeader('content-type', 'application/json');
    if (request.url === '/submit') response.end(JSON.stringify({ id: 'task-1', status: 'queued' }));
    else response.end(JSON.stringify({ status: 'done', result: 'https://cdn.example/result.mp4' }));
  });
  const baseUrl = await listen(server);
  const template = fixtureTemplate(baseUrl);
  const params = {
    provider: { id: 'fixture', name: 'fixture', protocol: 'fixture', baseUrl, authType: 'apikey' as const },
    capability: 'text2video',
    credentials: { apiKey: 'fixture-secret-key' },
    vars: { prompt: 'hello' },
  };
  try {
    assert.deepEqual(await submit(template, params), { taskId: 'task-1', status: 'queued' });
    assert.deepEqual(await poll(template, params, 'task-1'), {
      status: 'succeeded',
      resultUrl: 'https://cdn.example/result.mp4',
    });
    assert.deepEqual(seenAuthorization, ['Bearer fixture-secret-key', 'Bearer fixture-secret-key']);
    assert.equal(scrubCredentials('Bearer fixture-secret-key', params.credentials), 'Bearer ***');
  } finally {
    await close(server);
  }
});

test('provider response bodies fail closed above 4 MiB before parsing', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.setHeader('content-length', String(4 * 1024 * 1024 + 1));
    response.end('{}');
  });
  const baseUrl = await listen(server);
  try {
    await assert.rejects(
      submit(fixtureTemplate(baseUrl), {
        provider: {
          id: 'fixture',
          name: 'fixture',
          protocol: 'fixture',
          baseUrl,
          authType: 'apikey',
        },
        capability: 'text2video',
        credentials: { apiKey: 'fixture-secret-key' },
        vars: { prompt: 'hello' },
      }),
      /exceeds 4 MiB/,
    );
  } finally {
    await close(server);
  }
});

test('provider response bodies fail closed on invalid UTF-8', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(Buffer.from([0xc3, 0x28]));
  });
  const baseUrl = await listen(server);
  try {
    await assert.rejects(
      submit(fixtureTemplate(baseUrl), {
        provider: {
          id: 'fixture',
          name: 'fixture',
          protocol: 'fixture',
          baseUrl,
          authType: 'apikey',
        },
        capability: 'text2video',
        credentials: { apiKey: 'fixture-secret-key' },
        vars: { prompt: 'hello' },
      }),
      /encoded data was not valid|invalid encoding/i,
    );
  } finally {
    await close(server);
  }
});
