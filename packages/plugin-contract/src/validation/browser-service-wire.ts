import { createRequire } from 'node:module';
import { Buffer } from 'node:buffer';
import type { BrowserServiceRequest, BrowserServiceResponse, BrowserServiceHeader, BrowserServiceDispatchResult } from '../generated/contract.generated.js';
import { isBrowserServicePath } from './browser-service.js';
const require = createRequire(import.meta.url);
const Ajv = require('ajv/dist/2020');
const schema = require('@clowder-ai/plugin-contract/schemas/manifest');
const ajv = new Ajv({ strict: false });
const requestSchema = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/BrowserServiceRequest' });
const responseSchema = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/BrowserServiceResponse' });
const dispatchResultSchema = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/BrowserServiceDispatchResult' });
const requestHeaders = new Set(['accept', 'content-type', 'authorization', 'cookie', 'origin']);
const responseHeaders = new Set(['content-type', 'cache-control', 'etag', 'last-modified', 'location', 'retry-after', 'x-content-type-options', 'set-cookie']);
function headersValid(headers: readonly BrowserServiceHeader[], allowed: ReadonlySet<string>, response = false): boolean {
  let bytes = 0; const seen = new Set<string>();
  for (const header of headers) {
    if (!allowed.has(header.name) || /[\r\n\x00]/.test(header.value) || Buffer.byteLength(header.value) > 8192 ||
      (seen.has(header.name) && !(response && header.name === 'set-cookie'))) return false;
    seen.add(header.name); bytes += Buffer.byteLength(header.name) + Buffer.byteLength(header.value);
    if (bytes > 32768) return false;
    if (header.name === 'authorization' && !/^Bearer [^\s]+$/.test(header.value)) return false;
    if (header.name === 'location' && (!header.value.startsWith('/') || header.value.startsWith('//') || /[\\#\x00-\x20]/.test(header.value))) return false;
  }
  return true;
}
export function canonicalBrowserServiceBody(value: string, limit: number): boolean {
  if (value.length > Math.ceil(limit / 3) * 4 || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) return false;
  const body = Buffer.from(value, 'base64'); return body.length <= limit && body.toString('base64') === value;
}
export function validateBrowserServiceRequest(value: unknown): value is BrowserServiceRequest {
  if (!requestSchema(value)) return false; const input = value as BrowserServiceRequest;
  try { decodeURIComponent(input.rawQuery); } catch { return false; }
  return isBrowserServicePath(input.path) && !/[?#\x00-\x20\x7f]/.test(input.rawQuery) &&
    Buffer.byteLength(input.path) + (input.rawQuery ? Buffer.byteLength(input.rawQuery) + 1 : 0) <= 8192 &&
    headersValid(input.headers, requestHeaders) && canonicalBrowserServiceBody(input.rawBodyBase64, 262144) &&
    (input.method !== 'GET' || input.rawBodyBase64 === '');
}
export function validateBrowserServiceResponse(value: unknown): value is BrowserServiceResponse {
  if (!responseSchema(value)) return false; const input = value as BrowserServiceResponse;
  return headersValid(input.headers, responseHeaders, true) && canonicalBrowserServiceBody(input.bodyBase64, 33554432) &&
    (![204, 304].includes(input.status) || input.bodyBase64 === '');
}

/** Validate both closed union arms before interpreting effect or retry metadata. */
export function validateBrowserServiceDispatchResult(value: unknown): value is BrowserServiceDispatchResult {
  if (!dispatchResultSchema(value)) return false;
  const result = value as BrowserServiceDispatchResult;
  return result.kind === 'transport-error' || validateBrowserServiceResponse(result.response);
}
