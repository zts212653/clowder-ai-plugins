import assert from 'node:assert/strict';
import test from 'node:test';

import { WeixinAccessTokenManager } from './access-token-manager.js';

test('access-token manager caches, deduplicates refresh, and invalidates without persisting secrets', async () => {
  let requests = 0;
  const urls: string[] = [];
  const manager = new WeixinAccessTokenManager({
    appId: 'wx-app-id',
    appSecret: 'wx-app-secret',
    fetch: async (input) => {
      requests += 1;
      urls.push(String(input));
      await Promise.resolve();
      return new Response(JSON.stringify({ access_token: `token-${requests}`, expires_in: 7200 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.deepEqual(await Promise.all([manager.getAccessToken(), manager.getAccessToken()]), ['token-1', 'token-1']);
  assert.equal(requests, 1);
  assert.match(urls[0]!, /^https:\/\/api\.weixin\.qq\.com\/cgi-bin\/token\?/);
  assert.match(urls[0]!, /appid=wx-app-id/);
  assert.match(urls[0]!, /secret=wx-app-secret/);
  await manager.invalidateAccessToken();
  assert.equal(await manager.getAccessToken(), 'token-2');
  assert.equal(manager.isTokenExpiredError(42001), true);
  assert.equal(manager.isTokenExpiredError(40003), false);
});

test('access-token manager fails closed on HTTP and provider errors', async () => {
  const httpFailure = new WeixinAccessTokenManager({
    appId: 'id',
    appSecret: 'secret',
    fetch: async () => new Response('', { status: 503, statusText: 'Unavailable' }),
  });
  await assert.rejects(httpFailure.getAccessToken(), /HTTP 503/);

  const providerFailure = new WeixinAccessTokenManager({
    appId: 'id',
    appSecret: 'secret',
    fetch: async () => new Response(JSON.stringify({ errcode: 40013, errmsg: 'invalid appid' })),
  });
  await assert.rejects(providerFailure.getAccessToken(), /40013 invalid appid/);
});
