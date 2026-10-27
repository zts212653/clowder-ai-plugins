import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readOptional, readPrivateJson, writeNew } from './private-files.js';
import { credentials, MusicError, object, projectId } from './types.js';

const CLOUD_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
/** A plugin-owned receiver. It holds no Host client, opens no browser and submits no music request. */
export async function runOAuthReceiver(directory: string, request: typeof fetch = fetch) {
  const input = await readPrivateJson(join(directory, 'request.json'));
  if (!object(input) || typeof input.flowId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.flowId) ||
      typeof input.clientId !== 'string' || !/^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(input.clientId) ||
      typeof input.clientSecret !== 'string' || input.clientSecret.length > 2048 ||
      typeof input.expiresAt !== 'number' || input.expiresAt <= Date.now() || input.expiresAt > Date.now() + 600_000)
    throw new MusicError('oauth_client_required');
  const selected = projectId(input.projectId);
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  let redirect = '';
  let handling = false;
  let closed = false;
  const lifetime = new AbortController();
  let timer: ReturnType<typeof setInterval> | undefined;
  const canceled = async () => closed || Date.now() >= Number(input.expiresAt) || (await readOptional(join(directory, 'canceled.json'))) !== undefined;
  const finish = async () => {
    if (closed) return;
    closed = true;
    lifetime.abort();
    clearInterval(timer);
    await new Promise<void>(resolve => server.close(() => resolve()));
    await unlink(join(directory, 'request.json')).catch(() => {});
    await writeNew(join(directory, 'closed.json'), '{}').catch(() => {});
  };
  const failed = async (code: string) => {
    await writeNew(join(directory, 'failed.json'), JSON.stringify({ code })).catch(() => {});
  };
  const server = createServer((req, res) => {
    void (async () => {
      const reply = (status: number, message: string) => {
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        res.end(message);
      };
      if (req.method !== 'GET' || !req.url || req.url.length > 16_384 || req.headers.host !== new URL(redirect).host) { reply(400, 'Invalid callback.'); return; }
      const url = new URL(req.url, redirect);
      if (url.pathname !== '/oauth2/callback' || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== state) { reply(400, 'Invalid authorization state.'); return; }
      if (handling || await canceled()) { reply(409, 'This connection has ended. Return to the plugin card.'); return; }
      handling = true;
      if (url.searchParams.has('error') || url.searchParams.getAll('code').length !== 1) {
        await failed('oauth_authorization_required'); reply(400, 'Authorization was not completed. Return to the plugin card.'); await finish(); return;
      }
      try {
        const response = await request('https://oauth2.googleapis.com/token', {
          method: 'POST', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(15_000), lifetime.signal]),
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', code: url.searchParams.get('code')!,
            client_id: String(input.clientId), client_secret: String(input.clientSecret), redirect_uri: redirect, code_verifier: verifier }).toString(),
        });
        if (!response.ok || Number(response.headers.get('content-length')) > 16_384 || !response.body) {
          await response.body?.cancel(); throw new MusicError('oauth_authorization_required');
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            length += next.value.length;
            if (length > 16_384) throw new MusicError('oauth_invalid_response');
            chunks.push(next.value);
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const tokens: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!object(tokens) || tokens.token_type !== 'Bearer' || typeof tokens.scope !== 'string' || !tokens.scope.split(/\s+/).includes(CLOUD_SCOPE))
          throw new MusicError('cloud_scope_required');
        const grant = credentials({ type: 'authorized_user', client_id: input.clientId, client_secret: input.clientSecret,
          refresh_token: tokens.refresh_token, quota_project_id: selected });
        // Cancellation wins over a late token response. A later owner request alone adopts this result.
        if (await canceled()) throw new MusicError('oauth_canceled');
        await writeNew(join(directory, 'completed.json'), JSON.stringify({ flowId: input.flowId, projectId: selected, grant }));
        reply(200, 'Google Cloud 授权已收到。请回到配乐插件卡片完成连接；此操作没有生成音乐。');
      } catch (error) {
        await failed(error instanceof MusicError ? error.code : 'oauth_unavailable');
        reply(400, '授权未完成或 Cloud 权限未勾选。请回到配乐插件卡片查看并重新连接。');
      }
      await finish();
    })().catch(async () => { if (!res.headersSent) res.writeHead(500); res.end('Authorization receiver unavailable.'); await failed('oauth_unavailable'); await finish(); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new MusicError('oauth_receiver_unavailable');
  redirect = `http://127.0.0.1:${address.port}/oauth2/callback`;
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  for (const [key, value] of Object.entries({ response_type: 'code', client_id: String(input.clientId), redirect_uri: redirect,
    scope: `openid https://www.googleapis.com/auth/userinfo.email ${CLOUD_SCOPE}`, access_type: 'offline', prompt: 'consent',
    state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })) url.searchParams.set(key, value);
  try { await writeNew(join(directory, 'status.json'), JSON.stringify({ state: 'pending', authorizationUrl: url.href })); }
  catch (error) { await finish(); throw error; }
  timer = setInterval(() => {
    void canceled().then(async ended => { if (ended) { await failed('oauth_expired'); await finish(); } }).catch(() => finish());
  }, 1000);
  return { close: finish };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runOAuthReceiver(process.argv[2] ?? '').catch(() => { process.exitCode = 1; });
}
