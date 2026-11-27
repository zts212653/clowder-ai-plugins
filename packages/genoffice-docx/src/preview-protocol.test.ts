import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isConnectMessage,
  PREVIEW_BRIDGE_VERSION,
  isSnapshotMessage,
  PREVIEW_MEDIA_TYPES,
  previewFormatFor,
  readBootstrap,
} from './preview-protocol.js';

const ORIGIN = 'https://host.example';
const NONCE = 'handshake_0123456789abcdef0123456789abcdef';
const OTHER_NONCE = 'handshake_fedcba9876543210fedcba9876543210';
const DOCX = PREVIEW_MEDIA_TYPES.docx;
const PDF = PREVIEW_MEDIA_TYPES.pdf;
const PPTX = PREVIEW_MEDIA_TYPES.pptx;

test('reads the Host fragment and rejects ambiguous coordinates', () => {
  const hash = `#cat-cafe-parent-origin=${encodeURIComponent(ORIGIN)}&cat-cafe-handshake=${NONCE}`;
  assert.deepEqual(readBootstrap(hash, 'https://renderer.example'), {
    parentOrigin: ORIGIN,
    handshakeNonce: NONCE,
  });

  // Same-origin framing is a Host bug: the renderer origin must be dedicated.
  assert.throws(() => readBootstrap(hash, ORIGIN), /preview_origin_not_dedicated/);
  // Origins with a path/credentials are never accepted as an exact parent origin.
  assert.throws(
    () =>
      readBootstrap(
        `#cat-cafe-parent-origin=${encodeURIComponent('https://host.example/path')}&cat-cafe-handshake=${NONCE}`,
        'https://renderer.example',
      ),
    /preview_parent_origin_invalid/,
  );
  assert.throws(
    () => readBootstrap(`#cat-cafe-parent-origin=${encodeURIComponent(ORIGIN)}`, 'https://renderer.example'),
    /preview_handshake_invalid/,
  );
  const alternate = 'handshake_' + 'V-_1'.repeat(8);
  assert.equal(
    readBootstrap(
      '#cat-cafe-parent-origin=' + encodeURIComponent(ORIGIN) + '&cat-cafe-handshake=' + alternate,
      'https://renderer.example',
    ).handshakeNonce,
    alternate,
  );
  assert.throws(
    () =>
      readBootstrap(
        `#cat-cafe-parent-origin=${encodeURIComponent(ORIGIN)}&cat-cafe-handshake=abcDEF1234567890`,
        'https://renderer.example',
      ),
    /preview_handshake_invalid/,
  );
  assert.throws(
    () =>
      readBootstrap(
        `#cat-cafe-parent-origin=${encodeURIComponent('http://host.example')}&cat-cafe-handshake=${NONCE}`,
        'https://renderer.example',
      ),
    /preview_parent_origin_invalid/,
  );
});

test('connect requires the exact kind, nonce and bridge version', () => {
  const message = {
    v: 1,
    kind: 'cat-cafe-content-preview-connect',
    handshakeNonce: NONCE,
    bridgeVersion: PREVIEW_BRIDGE_VERSION,
  };
  assert.equal(isConnectMessage(message, NONCE), true);
  assert.equal(isConnectMessage(message, OTHER_NONCE), false);
  assert.equal(isConnectMessage({ ...message, bridgeVersion: undefined }, NONCE), false);
  assert.equal(isConnectMessage({ ...message, bridgeVersion: '2.0.0' }, NONCE), false);
  assert.equal(isConnectMessage({ ...message, kind: 'cat-cafe-content-preview-ready' }, NONCE), false);
  assert.equal(isConnectMessage({ ...message, v: 2 }, NONCE), false);
});

test('snapshot accepts one declared media type with real bytes only', () => {
  const base = {
    v: 1,
    kind: 'cat-cafe-content-preview-snapshot',
    fileName: '报告.pdf',
    mediaType: PDF,
    bytes: new ArrayBuffer(4),
  };
  const allowed = new Set([DOCX, PDF, PPTX]);
  assert.equal(isSnapshotMessage(base, allowed), true);
  assert.equal(isSnapshotMessage({ ...base, mediaType: DOCX }, allowed), true);
  assert.equal(isSnapshotMessage({ ...base, bytes: new ArrayBuffer(0) }, allowed), false);
  assert.equal(isSnapshotMessage({ ...base, mediaType: 'text/html' }, allowed), false);
  assert.equal(isSnapshotMessage({ ...base, fileName: '' }, allowed), false);
  assert.equal(isSnapshotMessage({ ...base, bytes: new Uint8Array(4) }, allowed), false);
});

test('format dispatch maps only declared media types', () => {
  assert.equal(previewFormatFor(DOCX), 'docx');
  assert.equal(previewFormatFor(PDF), 'pdf');
  assert.equal(previewFormatFor(PPTX), 'pptx');
  assert.equal(previewFormatFor('application/zip'), null);
});
