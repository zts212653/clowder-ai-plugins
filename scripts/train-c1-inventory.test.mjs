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
    contractDisposition: {
      status: 'closed-for-c1',
      machineTruth: '@clowder-ai/plugin-contract 0.1.0 and the published @clowder-ai/plugin-sdk surfaces',
      reusedSurfaces: [
        'manifest connector, webhook, schedule, config, secret, and capability declarations',
        'Host-issued connector_binding and the frozen messaging.send / host.messaging.deliver rows',
        'Host-owned FeatureContext config, secret, state, and contribution adapters',
      ],
    },
    pluginsImplementationLane: {
      owner: 'Plugins',
      status: 'implementation-active',
      requiredBehavior: [
        'complete every package-owned provider adapter, runtime entrypoint, schedule operation, and preservation journey',
        'use only the frozen contract and SDK surfaces without adding a C1 public ABI',
        'produce exact pack, catalog, conformance, and fresh-consumer evidence before publication',
      ],
    },
    coreImplementationLane: {
      owner: 'Core Host',
      status: 'implementation-active',
      requiredBehavior: [
        'map existing Host-owned configuration, secrets, bindings, state, schedules, webhooks, and delivery authority into the frozen plugin surfaces',
        'prove no double-run, switch the production defaults, and delete provider-specific Core implementations',
        'preserve secret redaction, durable state, rollback, and wake authority without business-specific Host branches',
      ],
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

test('GitHub Operations remains an explicit package implementation checkpoint', () => {
  const github = inventory.entries.find(entry => entry.id === 'github');
  assert.ok(github, 'GitHub Operations must remain in the frozen inventory');
  assert.equal(
    github.implementationStatus,
    'port-declared, implementation-pending-in-plugins',
  );
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
