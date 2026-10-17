import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalBrowserServiceBody, validateBrowserServiceRequest, validateBrowserServiceResponse, validateBrowserServiceDispatchResult } from './browser-service-wire.js';

const request = { version: 1, method: 'POST', path: '/api/events', rawQuery: '', headers: [], rawBodyBase64: '' };
const response = { status: 200, headers: [], bodyBase64: '' };
test('wire bodies enforce decoded byte limits and canonical padding without regex recursion', () => {
  for (const size of [0, 1, 2, 262144]) assert.equal(canonicalBrowserServiceBody(Buffer.alloc(size).toString('base64'), 262144), true);
  assert.equal(canonicalBrowserServiceBody(Buffer.alloc(262145).toString('base64'), 262144), false);
  for (const body of ['YQ', 'YR==', 'YQ===', 'YQ==\n', '====']) assert.equal(canonicalBrowserServiceBody(body, 262144), false);
  const largest = Buffer.alloc(33554432).toString('base64');
  assert.equal(validateBrowserServiceResponse({ ...response, bodyBase64: largest }), true);
  assert.equal(validateBrowserServiceResponse({ ...response, bodyBase64: Buffer.alloc(33554433).toString('base64') }), false);
});
test('request target, singleton headers and GET body fail closed', () => {
  assert.equal(validateBrowserServiceRequest(request), true);
  for (const rawQuery of ['x=%', 'x=1#fragment', 'x=?', 'x=\r\n', 'x=' + 'a'.repeat(8192)])
    assert.equal(validateBrowserServiceRequest({ ...request, rawQuery }), false);
  for (const headers of [
    [{ name: 'authorization', value: 'Basic secret' }],
    [{ name: 'origin', value: 'http://a' }, { name: 'origin', value: 'http://a' }],
    [{ name: 'cookie', value: 'x=1\r\nfoo:bar' }],
    [{ name: 'accept', value: 'é'.repeat(4097) }],
    [{ name: 'connection', value: 'close' }],
  ]) assert.equal(validateBrowserServiceRequest({ ...request, headers }), false);
  assert.equal(validateBrowserServiceRequest({ ...request, method: 'GET', rawBodyBase64: 'YQ==' }), false);
});
test('response headers preserve repeated cookies but reject duplicate singletons and redirect escape', () => {
  assert.equal(validateBrowserServiceResponse({ ...response, headers: [{ name: 'set-cookie', value: 'a=1' }, { name: 'set-cookie', value: 'b=2' }] }), true);
  for (const headers of [
    [{ name: 'content-type', value: 'a' }, { name: 'content-type', value: 'b' }],
    [{ name: 'location', value: '//external.example' }],
    [{ name: 'location', value: '/\\external.example' }],
    [{ name: 'access-control-allow-origin', value: '*' }],
    [{ name: 'etag', value: 'x'.repeat(8193) }],
  ]) assert.equal(validateBrowserServiceResponse({ ...response, headers }), false);
  for (const status of [204, 304]) assert.equal(validateBrowserServiceResponse({ ...response, status, bodyBase64: 'YQ==' }), false);
});
test('dispatch result cannot erase the typed failure retry prohibition or invent committed proof', () => {
  const failure = { kind: 'transport-error', code: 'BROWSER_SERVICE_TIMEOUT', effect: 'unknown', automaticRetry: false };
  assert.equal(validateBrowserServiceDispatchResult(failure), true);
  assert.equal(validateBrowserServiceDispatchResult({ kind: 'response', response }), true);
  for (const value of [null, {}, { ...failure, automaticRetry: true }, { ...failure, effect: 'committed' }, { ...failure, code: 'TIMEOUT' },
    { ...failure, response }, { kind: 'response', response: { ...response, bodyBase64: 'YQ' } }])
    assert.equal(validateBrowserServiceDispatchResult(value), false);
});
