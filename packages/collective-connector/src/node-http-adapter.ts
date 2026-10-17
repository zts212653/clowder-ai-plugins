import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { validateBrowserServiceRequest, validateBrowserServiceResponse } from '@clowder-ai/plugin-contract';
import type { BrowserServiceBinding, BrowserServiceContribution, BrowserServiceDispatchContext, BrowserServiceResponse } from '@clowder-ai/plugin-sdk';
import { createCollectiveHttpHandler } from './business/service/http-router.js';

function denied(): never { throw new Error('Collective browser-service request is not admitted'); }
function checkCookie(value: string, binding: BrowserServiceBinding, contribution: BrowserServiceContribution) {
  const parts = value.split(';').map(part => part.trim()); const first = parts.shift()!;
  const split = first.indexOf('='); if (split <= 0) denied();
  const name = first.slice(0, split), token = first.slice(split + 1);
  const declaration = contribution.credentials.cookies.find(cookie => cookie.name === name);
  if (!declaration) denied();
  const attrs = new Map<string, string>();
  for (const part of parts) {
    const [name, ...tail] = part.split('='); const key = name!.toLowerCase();
    if (attrs.has(key) || !['path', 'httponly', 'samesite', 'max-age', 'secure'].includes(key)) denied();
    attrs.set(key, tail.join('='));
  }
  const age = attrs.get('max-age');
  if (attrs.get('path') !== declaration.path || !attrs.has('httponly') || attrs.get('httponly') !== '' ||
    attrs.get('samesite') !== 'Strict' || !['0', String(declaration.maxAgeSeconds)].includes(age ?? '') ||
    (age === '0' ? token !== '' : !/^[A-Za-z0-9_-]{43}$/.test(token)) ||
    (new URL(binding.origin).protocol === 'https:' ? attrs.get('secure') !== '' : attrs.has('secure'))) denied();
}
/** Native Node request/response objects in memory, with no listen/bind/fetch fallback. */
export function createNodeHttpAdapter(options: Parameters<typeof createCollectiveHttpHandler>[0],
  binding: BrowserServiceBinding, contribution: BrowserServiceContribution) {
  const handler = createCollectiveHttpHandler(options);
  const origins = [...new Set(options.allowedHostOrigins.map(origin => new URL(origin).origin))];
  const expectedCsp = `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; frame-ancestors ${["'self'", ...origins].join(' ')}`;
  return async (input: unknown, nativeContext: unknown, context: BrowserServiceDispatchContext): Promise<BrowserServiceResponse> => {
    if (nativeContext !== undefined || context?.kind !== 'http' || context.contributionId !== contribution.id ||
      !input || typeof input !== 'object' || Object.keys(input).length !== 1 || !('request' in input) || !validateBrowserServiceRequest(input.request)) denied();
    const requestWire = input.request;
    const route = contribution.routes.find(route => route.method === requestWire.method && route.path === requestWire.path);
    if (!route || !(context.lane === 'local' ? route.local : route.browser)) denied();
    const origin = requestWire.headers.find(header => header.name === 'origin')?.value;
    if (context.lane === 'local') {
      if (route.local === 'parent-origin' ? origin !== binding.parentOrigin : origin !== undefined) denied();
      if (requestWire.headers.some(header => header.name === 'cookie')) denied();
    } else {
      const expected = route.browser === 'parent' ? binding.parentOrigin : binding.origin;
      if (route.browser !== 'callback' && (requestWire.method !== 'GET' ? origin !== expected : origin !== undefined && origin !== expected)) denied();
      if (route.browser === 'callback' && origin !== undefined && origin !== binding.origin) denied();
      const cookie = requestWire.headers.find(header => header.name === 'cookie')?.value;
      if (cookie) {
        const rows = cookie.split(';').map(value => value.trim());
        const names = new Set<string>();
        for (const row of rows) {
          const [name, ...value] = row.split('=');
          const declared = contribution.credentials.cookies.find(item => item.name === name && item.path === requestWire.path);
          if (!declared || names.has(name!) || !/^[A-Za-z0-9_-]{43}$/.test(value.join('='))) denied(); names.add(name!);
        }
      }
    }
    const assertCurrent = async () => { context.signal.throwIfAborted(); await context.assertCurrent(); await binding.assertCurrent(); context.signal.throwIfAborted(); };
    await assertCurrent();
    const chunks: Buffer[] = []; let size = 0;
    // A handle-less Socket supplies Node's HTTP surface; its writes terminate in bounded memory.
    class MemorySocket extends Socket {
      override _read() {}
      override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > binding.limits.responseBytes + binding.limits.headerBytes + 4096) { callback(new Error('Collective response is too large')); return; }
        chunks.push(bytes); callback();
      }
      override _writev(batch: Array<{ chunk: Buffer | string; encoding: BufferEncoding }>, callback: (error?: Error | null) => void) {
        for (const item of batch) {
          let failure: Error | null | undefined;
          this._write(item.chunk, item.encoding, error => { failure = error; });
          if (failure) { callback(failure); return; }
        }
        callback();
      }
    }
    const socket = new MemorySocket();
    const request = new IncomingMessage(socket); request.method = requestWire.method;
    request.url = requestWire.path + (requestWire.rawQuery ? '?' + requestWire.rawQuery : '');
    request.headers = Object.fromEntries(requestWire.headers.map(header => [header.name, header.value]));
    request.httpVersionMajor = 1; request.httpVersionMinor = 0; request.httpVersion = '1.0'; request.complete = true;
    request.push(Buffer.from(requestWire.rawBodyBase64, 'base64')); request.push(null);
    const response = new ServerResponse(request); response.assignSocket(socket);
    const finished = new Promise<void>((resolve, reject) => { response.once('finish', resolve); response.once('error', reject); socket.once('error', reject); });
    // Attach a rejection observer immediately, including errors during handler execution.
    void finished.catch(() => {});
    try {
      await assertCurrent(); await handler(request, response); await finished; await assertCurrent();
      const framed = Buffer.concat(chunks); const offset = framed.indexOf('\r\n\r\n'); if (offset < 0) denied();
      const body = framed.subarray(offset + 4); if (body.length > binding.limits.responseBytes) denied();
      const rows: Array<{ name: string; value: string }> = [];
      for (const [name, raw] of Object.entries(response.getHeaders())) {
        for (const value of Array.isArray(raw) ? raw : [raw]) {
          const text = String(value);
          if (name === 'content-security-policy') { if (text !== expectedCsp) denied(); continue; }
          if (name === 'referrer-policy') { if (text !== 'no-referrer') denied(); continue; }
          if (name === 'access-control-allow-origin') { if (text !== origin || !origins.includes(text)) denied(); continue; }
          if (name === 'set-cookie') checkCookie(text, binding, contribution);
          rows.push({ name, value: text });
        }
      }
      const result = { status: response.statusCode, headers: rows, bodyBase64: body.toString('base64') };
      if (!validateBrowserServiceResponse(result)) denied(); return result;
    } finally { request.destroy(); response.destroy(); socket.destroy(); }
  };
}
