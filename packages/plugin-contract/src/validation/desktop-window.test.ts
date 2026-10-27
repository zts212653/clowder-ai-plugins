import assert from 'node:assert/strict';
import test from 'node:test';
import { validateManifest } from './manifest.js';

function manifest() {
  return {
    pluginId: 'dev.clowder.companion',
    version: '0.1.0-alpha.0',
    contractVersion: '0.1.0-beta.16',
    name: 'Companion',
    runtime: { transport: 'builtin' },
    contributions: [{
      type: 'desktop-window',
      id: 'companion',
      role: 'companion',
      surface: { entrypoint: 'surface/index.html', integrity: `sha256-${'A'.repeat(43)}=` },
      bridgeVersion: '1.0.0',
      presentation: { width: 320, height: 350, transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true },
    }],
    features: [{
      id: 'companion',
      name: 'Companion',
      resources: [],
      contributions: [{ type: 'desktop-window', id: 'companion' }],

    }],
  };
}

test('window surfaces cannot select remote pages, executables or paths outside the package', () => {
  for (const entrypoint of ['https://example.org/window.html', '../outside.html', '/outside.html', 'surface/main.js', 'surface/../../outside.html']) {
    const input = manifest();
    input.contributions[0]!.surface.entrypoint = entrypoint;
    assert.equal(validateManifest(input).valid, false, entrypoint);
  }
});

test('renderer declarations cannot inject execution identity, Host origin or Electron preferences', () => {
  for (const patch of [
    { ownerUserId: 'other' }, { catId: 'other' }, { threadId: 'other' },
    { hostOrigin: 'http://127.0.0.1:3001' }, { webPreferences: { nodeIntegration: true } },
    { runtime: { entrypoint: 'malicious.js', transport: 'stdio' } },
  ]) {
    const input = manifest();
    Object.assign(input.contributions[0]!, patch);
    assert.equal(validateManifest(input).valid, false);
  }
});

test('surface integrity, bridge version and initial bounds are closed', () => {
  const visibleObservationBridge = manifest();
  visibleObservationBridge.contributions[0]!.bridgeVersion = '1.4.0';
  assert.equal(validateManifest(visibleObservationBridge).valid, true,
    'bridge 1.4 admits the renderer-to-Host visible-text observation');
  const boundedConversationBridge = manifest();
  boundedConversationBridge.contributions[0]!.bridgeVersion = '1.5.0';
  assert.equal(validateManifest(boundedConversationBridge).valid, true,
    'bridge 1.5 admits bounded conversation paging and body continuation');
  const splitCallAndAppAssistBridge = manifest();
  splitCallAndAppAssistBridge.contributions[0]!.bridgeVersion = '1.6.0';
  assert.equal(validateManifest(splitCallAndAppAssistBridge).valid, true,
    'bridge 1.6 admits split call geometry and Host-owned application-assistance settlement');
  const badIntegrity = manifest();
  badIntegrity.contributions[0]!.surface.integrity = 'trust-me';
  assert.equal(validateManifest(badIntegrity).valid, false);
  const unsupportedBridge = manifest();
  unsupportedBridge.contributions[0]!.bridgeVersion = '2.0.0';
  assert.equal(validateManifest(unsupportedBridge).valid, false);
  for (const size of [0, -1, 10_000, 300.5]) {
    const badSize = manifest();
    badSize.contributions[0]!.presentation.width = size;
    assert.equal(validateManifest(badSize).valid, false);
  }
});

test('window ownership cannot be shared between features or left dangling', () => {
  const shared = manifest();
  shared.features.push({ ...shared.features[0]!, id: 'another-feature' });
  assert.equal(validateManifest(shared).valid, false);
  const dangling = manifest();
  dangling.features[0]!.contributions[0]!.id = 'missing';
  assert.equal(validateManifest(dangling).valid, false);
});
