import assert from 'node:assert/strict';
import test from 'node:test';

import { WS_BACKUP, WS_PRIMARY } from './xiaoyi-protocol.js';
import { xiaoyiWebSocketOptions } from './xiaoyi-ws.js';

test('backup WebSocket keeps certificate verification and pins SNI to the primary service hostname', () => {
  const headers = { 'x-access-key': 'credential' };
  const options = xiaoyiWebSocketOptions(WS_BACKUP, headers);

  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.servername, new URL(WS_PRIMARY).hostname);
  assert.deepEqual(options.headers, {
    ...headers,
    Host: new URL(WS_PRIMARY).hostname,
  });
});

test('custom WebSocket endpoints remain fail-closed under ordinary TLS validation', () => {
  const options = xiaoyiWebSocketOptions('wss://192.0.2.1/custom', {});
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.servername, undefined);
});
