import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BridgeDeniedError,
  createGenOfficeDesktopBridge,
  installNetworkDeny,
  type HostBridgeTransport,
} from './host-bridge.js';

test('loads and settles the owner revision while ignoring the renderer path', async () => {
  const calls: Array<{ operation: string; payload: unknown }> = [];
  const transport: HostBridgeTransport = {
    async request(operation, payload) {
      calls.push({ operation, payload });
      if (operation === 'content.load') {
        return {
          contentIdentity: 'opaque-doc-1',
          fileName: 'shared.docx',
          ownerRevision: 7,
          blobDigest: `sha256:${'a'.repeat(64)}`,
          bytes: new Uint8Array([80, 75, 3, 4]).buffer,
        };
      }
      return {
        receiptId: 'receipt-8',
        ownerRevision: 8,
        blobDigest: `sha256:${'b'.repeat(64)}`,
      };
    },
  };
  const desktop = createGenOfficeDesktopBridge(transport, {
    operationId: () => 'operation-8',
    language: 'zh',
    theme: 'system',
  });

  const opened = await desktop.consumePendingOpenDocx();
  assert.equal(opened.path, 'content://opaque-doc-1');
  assert.equal(opened.name, 'shared.docx');
  assert.equal(opened.hash, 'a'.repeat(64));

  const result = await desktop.saveDocx('/tmp/forged.docx', new Uint8Array([1, 2, 3]).buffer);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [
    { operation: 'content.load', payload: {} },
    {
      operation: 'content.settle',
      payload: {
        expectedOwnerRevision: 7,
        bytes: new Uint8Array([1, 2, 3]).buffer,
        operationId: 'operation-8',
      },
    },
  ]);
});

test('maps owner conflict honestly and never dispatches denied Electron powers', async () => {
  const calls: string[] = [];
  const transport: HostBridgeTransport = {
    async request(operation) {
      calls.push(operation);
      if (operation === 'content.load') {
        return {
          contentIdentity: 'opaque-doc-1',
          fileName: 'shared.docx',
          ownerRevision: 7,
          blobDigest: `sha256:${'a'.repeat(64)}`,
          bytes: new ArrayBuffer(0),
        };
      }
      throw Object.assign(new Error('stale owner revision'), { code: 'owner_revision_conflict' });
    },
  };
  const desktop = createGenOfficeDesktopBridge(transport, {
    operationId: () => 'operation-conflict',
    language: 'en',
    theme: 'light',
  });
  await desktop.consumePendingOpenDocx();
  assert.deepEqual(await desktop.saveDocx('ignored', new ArrayBuffer(0)), {
    ok: false,
    reason: 'external-modified',
  });

  await assert.rejects(desktop.openDocx(), BridgeDeniedError);
  await assert.rejects(desktop.aiGskLogin(), BridgeDeniedError);
  await assert.rejects(desktop.webSearch('escape'), BridgeDeniedError);
  assert.deepEqual(calls, ['content.load', 'content.settle']);
  assert.throws(() => (desktop as Record<string, unknown>).notDeclared, /unknown bridge method/i);
});

test('only exposes bounded presentation compatibility without a raw Host object', async () => {
  const desktop = createGenOfficeDesktopBridge(
    { request: async () => assert.fail('presentation compatibility must stay local') },
    { operationId: () => 'unused', language: 'ja', theme: 'dark' },
  );
  assert.equal(await desktop.getLanguage(), 'ja');
  assert.equal(await desktop.getTheme(), 'dark');
  assert.deepEqual(await desktop.getRecentFiles(), []);
  assert.deepEqual(await desktop.getAiSettings(), {
    provider: 'custom',
    providers: {},
    gskToolsEnabled: false,
  });
  assert.equal(await desktop.consumeNewBlankDoc(), false);
  assert.equal(await desktop.consumeAiDocContent(), null);
  assert.equal(desktop.onOpenDocx(() => undefined)(), undefined);
  assert.equal('host' in desktop, false);
  assert.equal('request' in desktop, false);
});

test('installs runtime network denial before upstream code can reach browser transports', async () => {
  const target: Record<string, unknown> = {
    fetch: async () => 'escaped',
    XMLHttpRequest: class {},
    WebSocket: class {},
    EventSource: class {},
    navigator: { sendBeacon: () => true },
  };
  installNetworkDeny(target);
  await assert.rejects(
    (target.fetch as (url: string) => Promise<unknown>)('https://example.invalid'),
    BridgeDeniedError,
  );
  for (const name of ['XMLHttpRequest', 'WebSocket', 'EventSource']) {
    const Blocked = target[name] as new () => unknown;
    assert.throws(() => new Blocked(), BridgeDeniedError);
  }
  assert.throws(
    () => (target.navigator as { sendBeacon(): boolean }).sendBeacon(),
    BridgeDeniedError,
  );
});
