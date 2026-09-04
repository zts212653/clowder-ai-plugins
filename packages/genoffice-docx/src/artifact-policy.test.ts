import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertPackEntries,
  injectHostPolicy,
  sha256Sri,
} from './artifact-policy.js';

test('injects CSP, AI-off bootstrap, and the Host bridge before upstream renderer code', () => {
  const html = `<!doctype html><html><head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' ws://localhost:*">
    <script type="module" src="./assets/index-abc.js"></script>
  </head><body><div id="root"></div></body></html>`;
  const hardened = injectHostPolicy(html, {
    bridgePath: './host-bridge.js',
    policyCssPath: './host-policy.css',
  });
  assert.match(hardened, /connect-src 'none'/);
  assert.doesNotMatch(hardened, /connect-src 'self'/);
  assert.match(hardened, /frame-ancestors 'none'/);
  assert.equal(hardened.match(/Content-Security-Policy/g)?.length, 1);
  assert.ok(hardened.indexOf('host-policy.css') < hardened.indexOf('index-abc.js'));
  assert.ok(hardened.indexOf('host-bridge.js') < hardened.indexOf('index-abc.js'));
});

test('pack scan rejects Electron, source trees, enterprise code, and credentials', () => {
  assert.doesNotThrow(() =>
    assertPackEntries([
      'package/plugin.yaml',
      'package/renderer/index.html',
      'package/renderer/assets/index.js',
      'package/NOTICE',
    ]),
  );
  for (const forbidden of [
    'package/renderer/preload/index.js',
    'package/renderer/main/index.js',
    'package/node_modules/electron/index.js',
    'package/ee/private.js',
    'package/.env',
    'package/upstream-source/apps/docs/App.tsx',
  ]) {
    assert.throws(() => assertPackEntries([forbidden]), /forbidden pack entry/i, forbidden);
  }
});

test('surface integrity uses standard sha256 SRI', () => {
  assert.equal(
    sha256Sri(Buffer.from('renderer')),
    'sha256-a9UrIE9bTP+yZ1l/N9D6YrriKTQTlN/sDl1CQ52Lciw=',
  );
});

test('renderer build uses frozen local Vite and cannot fall back to online npm exec', async () => {
  const script = await readFile(join(import.meta.dirname, '..', 'scripts', 'build-renderer.mjs'), 'utf8');
  assert.match(script, /'ci', '--ignore-scripts', '--include=dev'/);
  assert.match(script, /node_modules.*\.bin.*vite/);
  assert.match(script, /'--base', '\.\/'/);
  assert.doesNotMatch(script, /'npm',[\s\S]*'exec'/);
});
