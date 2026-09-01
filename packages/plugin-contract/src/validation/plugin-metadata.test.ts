import assert from 'node:assert/strict';
import test from 'node:test';

import { validateManifest } from './manifest.js';

function manifest() {
  return {
    pluginId: 'dev.clowder.metadata-fixture',
    version: '1.0.0',
    contractVersion: '0.1.0-beta.13',
    name: 'Metadata fixture',
    features: [{ id: 'main', name: 'Main', resources: [], capabilities: [] }],
    runtime: { transport: 'builtin' },
  };
}

test('accepts legacy metadata while admitting one localized manifest truth', () => {
  assert.equal(validateManifest(manifest()).valid, true, 'metadata remains optional for old manifests');
  assert.equal(
    validateManifest({ ...manifest(), description: 'Legacy description', icon: 'github' }).valid,
    true,
  );
  assert.equal(
    validateManifest({
      ...manifest(),
      description: {
        default: 'Describe capabilities for agents and people.',
        translations: {
          'en-US': 'Describe capabilities for agents and people.',
          'zh-CN': '向 Agent 和用户介绍插件能力。',
        },
      },
      icon: { type: 'svg', src: 'assets/icon.svg' },
    }).valid,
    true,
  );
  assert.equal(
    validateManifest({ ...manifest(), icon: { type: 'png', src: 'assets/icon.png' } }).valid,
    true,
  );
});

test('rejects open translations and icons outside the package-local typed asset boundary', () => {
  const localized = {
    default: 'Default description',
    translations: { 'zh-CN': '中文描述' },
  };
  for (const description of [
    { default: '', translations: { 'zh-CN': '中文描述' } },
    { default: 'Default description', translations: {} },
    { default: 'Default description', translations: { '../zh': '中文描述' } },
  ]) {
    assert.equal(validateManifest({ ...manifest(), description }).valid, false);
  }

  for (const icon of [
    { type: 'svg', src: 'https://cdn.example/icon.svg' },
    { type: 'svg', src: '../assets/icon.svg' },
    { type: 'svg', src: '/assets/icon.svg' },
    { type: 'svg', src: 'assets/icon.png' },
    { type: 'png', src: 'assets/icon.svg' },
    { type: 'gif', src: 'assets/icon.gif' },
  ]) {
    assert.equal(validateManifest({ ...manifest(), description: localized, icon }).valid, false);
  }
});
