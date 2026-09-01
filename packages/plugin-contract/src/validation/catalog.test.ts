import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getCatalogPlugin,
  listCatalogPlugins,
  searchCatalogPlugins,
  validatePluginCatalog,
} from './catalog.js';

const INTEGRITY = `sha512-${'A'.repeat(86)}==`;

function catalog() {
  return {
    schemaVersion: '1',
    plugins: [
      {
        pluginId: 'dev.clowder.alpha',
        name: 'Alpha tools',
        description: 'First catalog entry',
        publisher: { id: 'clowder-ai', name: 'Clowder AI' },
        keywords: ['analysis'],
        versions: [
          {
            version: '1.0.0',
            contractVersion: '0.1.0-beta.13',
            manifestPath: 'plugin.yaml',
            artifact: {
              kind: 'npm',
              packageName: '@clowder-ai/alpha',
              version: '1.0.0',
              tarballUrl: 'https://registry.npmjs.org/@clowder-ai/alpha/-/alpha-1.0.0.tgz',
              integrity: INTEGRITY,
              shasum: 'a'.repeat(40),
              provenance: {
                repository: 'https://github.com/zts212653/clowder-ai-plugins',
                sourceDirectory: 'packages/alpha',
              },
            },
          },
        ],
      },
      {
        pluginId: 'dev.clowder.video-analysis',
        name: 'Video Analysis',
        description: 'Analyze remote videos with configured providers',
        publisher: { id: 'clowder-ai', name: 'Clowder AI' },
        keywords: ['gemini', 'video', 'zhipu'],
        versions: [
          {
            version: '0.1.0-alpha.0',
            contractVersion: '0.1.0-beta.13',
            manifestPath: 'plugin.yaml',
            artifact: {
              kind: 'npm',
              packageName: '@clowder-ai/video-analysis',
              version: '0.1.0-alpha.0',
              tarballUrl:
                'https://registry.npmjs.org/@clowder-ai/video-analysis/-/video-analysis-0.1.0-alpha.0.tgz',
              integrity: INTEGRITY,
              shasum: 'c'.repeat(40),
              provenance: {
                repository: 'https://github.com/zts212653/clowder-ai-plugins',
                sourceDirectory: 'packages/video-analysis',
              },
            },
          },
        ],
      },
    ],
  };
}

test('validates immutable catalog coordinates without installed-state fields', () => {
  const value = catalog();
  const result = validatePluginCatalog(value);
  assert.equal(result.valid, true);
  if (result.valid) assert.equal(result.catalog, value);

  assert.equal(
    validatePluginCatalog({
      ...value,
      plugins: [{ ...value.plugins[0], enabled: true }],
    }).valid,
    false,
    'catalog must not become a second Host inventory',
  );
  assert.equal(
    validatePluginCatalog({
      ...value,
      plugins: [
        {
          ...value.plugins[0],
          versions: [
            {
              ...value.plugins[0].versions[0],
              artifact: { ...value.plugins[0].versions[0].artifact, version: '^1.0.0' },
            },
          ],
        },
      ],
    }).valid,
    false,
  );
  assert.equal(
    validatePluginCatalog({
      ...value,
      plugins: [
        {
          ...value.plugins[0],
          versions: [
            {
              ...value.plugins[0].versions[0],
              artifact: {
                ...value.plugins[0].versions[0].artifact,
                tarballUrl: 'https://packages.example/alpha-1.0.0.tgz',
              },
            },
          ],
        },
      ],
    }).valid,
    false,
    'npm artifacts cannot redirect immutable coordinates to another origin',
  );
});

test('rejects duplicate IDs, version drift, and nondeterministic catalog ordering', () => {
  const value = catalog();
  assert.equal(
    validatePluginCatalog({ ...value, plugins: [value.plugins[0], value.plugins[0]] }).valid,
    false,
  );
  assert.equal(
    validatePluginCatalog({
      ...value,
      plugins: [
        {
          ...value.plugins[0],
          versions: [
            {
              ...value.plugins[0].versions[0],
              artifact: { ...value.plugins[0].versions[0].artifact, version: '1.0.1' },
            },
          ],
        },
      ],
    }).valid,
    false,
  );
  assert.equal(validatePluginCatalog({ ...value, plugins: [...value.plugins].reverse() }).valid, false);

  const unsortedKeywords = catalog();
  unsortedKeywords.plugins[0].keywords = ['zeta', 'alpha'];
  assert.equal(validatePluginCatalog(unsortedKeywords).valid, false);
});

test('orders full SemVer identifiers without numeric precision or hyphen truncation', () => {
  const value = catalog();
  value.plugins[0].versions = [
    structuredClone(value.plugins[0].versions[0]),
    structuredClone(value.plugins[0].versions[0]),
  ];
  value.plugins[0].versions[0].version = '9007199254740993.0.0-alpha-beta';
  value.plugins[0].versions[0].artifact.version = '9007199254740993.0.0-alpha-beta';
  value.plugins[0].versions[0].artifact.tarballUrl =
    'https://registry.npmjs.org/@clowder-ai/alpha/-/alpha-9007199254740993.0.0-alpha-beta.tgz';
  value.plugins[0].versions[1].version = '9007199254740992.0.0-alpha';
  value.plugins[0].versions[1].artifact.version = '9007199254740992.0.0-alpha';
  value.plugins[0].versions[1].artifact.tarballUrl =
    'https://registry.npmjs.org/@clowder-ai/alpha/-/alpha-9007199254740992.0.0-alpha.tgz';
  assert.equal(validatePluginCatalog(value).valid, true);

  value.plugins[0].versions.reverse();
  assert.equal(validatePluginCatalog(value).valid, false);

  value.plugins[0].versions[0].version = '1.0.0-alpha-beta';
  value.plugins[0].versions[0].artifact.version = '1.0.0-alpha-beta';
  value.plugins[0].versions[0].artifact.tarballUrl =
    'https://registry.npmjs.org/@clowder-ai/alpha/-/alpha-1.0.0-alpha-beta.tgz';
  value.plugins[0].versions[1].version = '1.0.0-alpha';
  value.plugins[0].versions[1].artifact.version = '1.0.0-alpha';
  value.plugins[0].versions[1].artifact.tarballUrl =
    'https://registry.npmjs.org/@clowder-ai/alpha/-/alpha-1.0.0-alpha.tgz';
  assert.equal(validatePluginCatalog(value).valid, true);
});

test('list/search/get are deterministic projections of catalog truth', () => {
  const result = validatePluginCatalog(catalog());
  assert.equal(result.valid, true);
  if (!result.valid) return;

  assert.deepEqual(
    listCatalogPlugins(result.catalog).map((entry) => entry.pluginId),
    ['dev.clowder.alpha', 'dev.clowder.video-analysis'],
  );
  assert.deepEqual(
    searchCatalogPlugins(result.catalog, 'VIDEO').map((entry) => entry.pluginId),
    ['dev.clowder.video-analysis'],
  );
  assert.equal(getCatalogPlugin(result.catalog, 'dev.clowder.video-analysis')?.version, '0.1.0-alpha.0');
  assert.equal(getCatalogPlugin(result.catalog, 'missing'), undefined);
});
