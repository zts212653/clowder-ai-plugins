import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { requestStackChanPlay } from './play-command.js';

test('owner play commands reach the paired adapter and surface its real readiness and failures', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'stackchan-play-cli-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const apiKeyPath = join(dir, 'key');
  await writeFile(apiKeyPath, 'fixture-owner-key', {mode: 0o600});
  const received: Array<{url: string; body: string}> = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer fixture-owner-key');
    let body = '';
    for await (const chunk of request) body += chunk;
    received.push({url: request.url ?? '', body});
    response.setHeader('content-type', 'application/json');
    if (request.url === '/health') response.end('{"status":"offline"}');
    else { response.statusCode = 409; response.end('{"error":"机器人尚未连接网关"}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const config = {apiKeyPath, limbEndpointUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`};
  assert.deepEqual(await requestStackChanPlay(config, 'status'), {status: 'offline'});
  await assert.rejects(requestStackChanPlay(config, 'bicker'), /尚未连接/);
  await assert.rejects(requestStackChanPlay(config, 'unbounded-command'), /named scene/);
  assert.deepEqual(received, [{url: '/health', body: ''}, {url: '/play', body: '{"scene":"bicker"}'}]);
});
