import { timingSafeEqual } from 'node:crypto';
import { fail } from './config.mjs';

export function requestPath(request, port) {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(request.headers.host)) fail('HOST_REJECTED', '请求 Host 不属于本地工作台');
  const origins = hosts.map((host) => `http://${host}`);
  if (request.headers.origin && !origins.includes(request.headers.origin)) fail('ORIGIN_REJECTED', '拒绝跨站请求');
  return new URL(request.url, origins[0]).pathname;
}
export function requireToken(request, token) {
  const supplied = Buffer.from(request.headers['x-repo-sync-token'] ?? '');
  const expected = Buffer.from(token);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
    fail('TOKEN_REJECTED', '请求缺少有效会话令牌');
}
export async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65536) fail('BODY_TOO_LARGE', '请求超过 64 KiB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function send(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}
