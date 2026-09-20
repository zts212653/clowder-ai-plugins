import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const inventory = JSON.parse(
  await readFile(new URL('../migration/f202-train-c1-inventory.json', import.meta.url), 'utf8'),
);
const catalog = JSON.parse(
  await readFile(new URL('../catalog/catalog.json', import.meta.url), 'utf8'),
);

const expectedMigrationIds = [
  'dingtalk',
  'feishu',
  'github',
  'telegram',
  'video-gen',
  'wechat-visible-reader',
  'wecom-agent',
  'wecom-bot',
  'weixin',
  'weixin-mp',
  'xiaoyi',
];

const expectedC2ExclusionIds = [
  'asr',
  'audio-capture',
  'embedding-model',
  'llm-postprocess',
  'tts',
];

const requiredPreservationFields = [
  'sourceRoots',
  'configKeys',
  'secretKeys',
  'bindingData',
  'data',
  'currentConsumers',
  'dedicatedJourneys',
  'runtimeRequirements',
];

test('Train C1 inventory freezes the exact migration and C2 exclusion sets', () => {
  const migrationIds = inventory.entries
    .filter(entry => entry.disposition === 'migrate')
    .map(entry => entry.id)
    .sort();
  assert.deepEqual(migrationIds, expectedMigrationIds);
  assert.deepEqual(inventory.c2Exclusions.map(entry => entry.id).sort(), expectedC2ExclusionIds);
  assert.equal(
    migrationIds.some(id => expectedC2ExclusionIds.includes(id)),
    false,
    'Train C2 managed services must never enter the Train C1 aggregate',
  );
});

test('connector ingress keeps binding and wake authority in the Host', () => {
  assert.deepEqual(inventory.trustBoundary, {
    connectorIngressTarget: 'connector_binding',
    bindingAuthority: 'Host',
    wakeAuthority: 'Host',
    connectorBindingBootstrap: {
      owner: 'Core Host',
      status: 'required-prerequisite',
      missingAtCoreSourceCommit:
        'No production caller issues or restores connector_binding handles for an external package runtime',
      requiredBehavior: [
        'resolve or create an opaque binding handle for an authenticated plugin instance and connector/external-chat coordinate',
        'provide restart-safe outbound external-chat coordinates without exposing Host wake policy to the package',
      ],
    },
    runtimeConfigurationProjection: {
      owner: 'Core Host',
      status: 'required-prerequisite',
      missingAtCoreSourceCommit:
        'External stdio supervisor injects only four CLOWDER protocol metadata values and exposes no connector config/secret read path',
      requiredBehavior: [
        'project only manifest-declared configuration and secrets into the verified package runtime',
        'preserve secret redaction and deny ambient Host environment access',
      ],
    },
    durableCheckpointAuthority: {
      owner: 'Core Host',
      status: 'required-prerequisite',
      missingAtCoreSourceCommit:
        'plugin.state.get/set are reserved capability names but are absent from the frozen wire registry and have no Core handler, store, or external-runtime composition path',
      stableAssumptions: [
        'namespace derives from authenticated plugin instance, contribution, and a manifest-declared key',
        'checkpoint values persist with TTL=0 and survive restart or rollback of the same installed instance',
        'writes use compare-and-swap plus operation-id idempotency',
        'delivery checkpoints advance only after the corresponding messaging.send settlement so replay converges without skipped or duplicate messages',
        'checkpoint values contain operational cursors, sequences, resume tokens, or deduplication watermarks only and never messages or credentials',
      ],
      signatureStatus: 'unapproved-public-contract-delta',
    },
    ordinaryPluginText: 'opaque non-waking content, including text containing @',
    forbiddenPackageBehavior: [
      'minting or resolving connector binding handles',
      'parsing mentions to derive wake authority',
      'supplying a raw thread identity as authenticated connector ingress',
      'using package config or environment values as a substitute for Host-issued connector binding state',
      'reading repository or ambient Host environment as a substitute for manifest-declared runtime configuration',
      'persisting cursors, sequences, resume tokens, or deduplication watermarks in package-local files or ambient stores',
      'reusing messaging subscription cursors, settlement receipts, or inventory snapshots as connector checkpoint state',
    ],
  });
});

test('every migration entry carries preservation and rollback truth', () => {
  const migrationEntries = inventory.entries.filter(entry => entry.disposition === 'migrate');
  const packageNames = new Set();
  const pluginIds = new Set();

  for (const entry of migrationEntries) {
    for (const field of requiredPreservationFields) {
      assert.ok(Array.isArray(entry[field]), `${entry.id}.${field} must be an array`);
      if (!['configKeys', 'secretKeys'].includes(field)) {
        assert.ok(entry[field].length > 0, `${entry.id}.${field} must not be empty`);
      }
    }
    assert.match(entry.targetPackage, /^@clowder-ai\/[a-z0-9-]+$/u);
    assert.match(entry.catalogPluginId, /^(?:dev\.clowder|official)\.[a-z0-9.-]+$/u);
    assert.ok(entry.rollback.length > 0, `${entry.id}.rollback must not be empty`);
    assert.equal(packageNames.has(entry.targetPackage), false, `duplicate package ${entry.targetPackage}`);
    assert.equal(pluginIds.has(entry.catalogPluginId), false, `duplicate pluginId ${entry.catalogPluginId}`);
    packageNames.add(entry.targetPackage);
    pluginIds.add(entry.catalogPluginId);
  }
});

test('every migration target is a package-owned, cataloged artifact', async () => {
  const catalogIds = new Set(catalog.plugins.map(entry => entry.pluginId));

  for (const entry of inventory.entries.filter(candidate => candidate.disposition === 'migrate')) {
    const packageDirectory = new URL(`../packages/${entry.targetPackage.split('/').at(-1)}/`, import.meta.url);
    await Promise.all([
      access(new URL('package.json', packageDirectory)),
      access(new URL('plugin.yaml', packageDirectory)),
      access(new URL('README.md', packageDirectory)),
      access(new URL('assets/icon.svg', packageDirectory)),
    ]);
    assert.ok(catalogIds.has(entry.catalogPluginId), `${entry.catalogPluginId} is missing from catalog`);
  }
});

test('inventory provenance is pinned to the independently grounded repositories', () => {
  assert.equal(inventory.scopeAuthority.pluginsBaseCommit, '123112c');
  assert.equal(
    inventory.scopeAuthority.coreSourceCommit,
    '9ab0eaf287381efcb209781463f38cc5f23870ea',
  );
  assert.equal(inventory.scopeAuthority.acceptedCoreIssue, 'zts212653/clowder-ai#1478');
});
