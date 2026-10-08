import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

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

const requiredInstallableClosureFields = [
  'contractClosure',
  'sdkClosure',
  'yamlClosure',
  'runtimeClosure',
  'catalogClosure',
  'freshConsumerClosure',
];

test('C1 terminal contract freezes the two-PR carrier-neutral finish line', () => {
  assert.deepEqual(inventory.terminalAcceptanceContract, {
    distributionUnit: 'package',
    runtimeCarrier: 'manifest-selected implementation detail',
    hostBoundary: 'one carrier-neutral lifecycle/action boundary',
    pluginsClosure: 'PR #54 closes repository-wide contract, SDK, YAML, package, runtime, catalog, pack, and fresh-consumer compatibility',
    coreClosure: 'PR #1487 consumes exact artifacts, converges Host lifecycle, cuts over without double-run, and atomically deletes legacy execution paths',
    dependencyOrder: [
      'Plugins exact Linux-packed artifact',
      'Core exact-artifact integration journey',
      'Plugins merge and registry publication',
      'Core registry pin, final journey, and merge',
    ],
    recovery: [
      'disable and uninstall revoke actions and restore the preserved Host baseline',
      'failed start exposes zero partial actions',
      'restart restores Host-owned durable state without double-run',
      'Core contains no package-id or provider-specific runtime branch',
    ],
    nextPhase: 'C2 front-end contribution surfaces, including retained StackChan physical-hardware limb work',
    c1AgentContributionConsumers: [
      'wechat-visible-reader limb/skill contribution consumption',
      'weixin-mp limb/skill contribution consumption',
    ],
    followupPolicy: 'no C1 cleanup follow-up PR',
  });
});

test('every repository package is classified and Manager artifacts carry explicit closure', async () => {
  const packageDirectories = (await readdir(new URL('../packages/', import.meta.url), {
    withFileTypes: true,
  }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  const classifiedDirectories = inventory.repositoryPackages.map(entry => entry.directory).sort();
  assert.deepEqual(classifiedDirectories, packageDirectories);

  const allowedClassifications = new Set([
    'manager-installable-official-public',
    'retained-external-baseline-specialized-host-wiring',
    'non-installable-library-or-fixture',
    'deprecated-or-migrated-artifact',
  ]);
  for (const entry of inventory.repositoryPackages) {
    assert.equal(
      allowedClassifications.has(entry.classification),
      true,
      `${entry.directory} has unknown classification ${entry.classification}`,
    );
    assert.match(entry.packageName, /^@clowder-ai\/[a-z0-9-]+$/u);
    if (entry.managerInstallable) {
      assert.equal(entry.classification, 'manager-installable-official-public');
      for (const field of requiredInstallableClosureFields) {
        assert.equal(typeof entry[field], 'string', `${entry.directory}.${field} must be explicit`);
        assert.ok(entry[field].length > 0, `${entry.directory}.${field} must not be empty`);
      }
      await access(new URL(`../packages/${entry.directory}/plugin.yaml`, import.meta.url));
    } else {
      assert.equal(typeof entry.boundary, 'string', `${entry.directory}.boundary must be explicit`);
      assert.ok(entry.boundary.length > 0, `${entry.directory}.boundary must not be empty`);
    }
  }
});

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
      status: 'carrier-neutral-lifecycle-completion-in-c1',
      machineTruth: '@clowder-ai/plugin-contract protocol line 0.1.0, frozen 13-row wire, and @clowder-ai/plugin-sdk 0.1.0-beta.12 module/lifecycle/action boundary',
      reusedSurfaces: [
        'manifest connector, webhook, schedule, config, secret, and capability declarations',
        'Host-issued connector_binding and the frozen messaging.send / host.messaging.deliver rows',
        'Host-owned FeatureContext config, secret, state, connector ingress, logging, and contribution adapters',
        'manifest-selected builtin or external carrier behind one feature activation/action/disposal contract',
      ],
    },
    pluginsImplementationLane: {
      owner: 'Plugins',
      status: 'implementation-active',
      requiredBehavior: [
        'complete every package-owned provider adapter, runtime entrypoint, schedule operation, and preservation journey',
        'complete the carrier-neutral SDK module/action boundary without adding provider-specific wire methods',
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

  const migrationEntries = inventory.entries.filter(candidate => candidate.disposition === 'migrate');
  // The frozen C1 plan pins GitHub Operations as the single implementation-pending
  // checkpoint: its catalog entry lands together with its schedule/event
  // implementation. Every other migration target must already be cataloged, and
  // the moment github's implementationStatus flips this gate requires its
  // catalog row — the exemption is pinned to exactly one entry, not open-ended.
  const pendingCheckpointIds = migrationEntries
    .filter(candidate => candidate.implementationStatus === 'port-declared, implementation-pending-in-plugins')
    .map(candidate => candidate.id);
  assert.deepEqual(pendingCheckpointIds, ['github']);

  for (const entry of migrationEntries) {
    const packageDirectory = new URL(`../packages/${entry.targetPackage.split('/').at(-1)}/`, import.meta.url);
    await Promise.all([
      access(new URL('package.json', packageDirectory)),
      access(new URL('plugin.yaml', packageDirectory)),
      access(new URL('README.md', packageDirectory)),
      access(new URL('assets/icon.svg', packageDirectory)),
    ]);
    if (pendingCheckpointIds.includes(entry.id)) continue;
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
  assert.deepEqual(inventory.scopeAuthority.coreCounterpartRead, {
    pullRequest: 'zts212653/clowder-ai#1487',
    head: 'f20cc2dcd0c6612b89bf57d10f39a7fee802d0df',
    path: 'docs/plans/2026-09-19-f202-train-c1-migration-plan.md',
  });
});

async function declaredCapabilities(packageName) {
  // Fail-closed: a missing/unparseable plugin.yaml, a missing features array,
  // or a feature without an explicit capabilities array all fail the gate.
  const manifest = parse(await readFile(new URL(`../packages/${packageName}/plugin.yaml`, import.meta.url), 'utf8'));
  assert.ok(manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest),
    `${packageName} plugin.yaml must parse to an object`);
  assert.ok(Array.isArray(manifest.features), `${packageName} plugin.yaml must declare a features array`);
  const declared = new Set();
  for (const feature of manifest.features) {
    assert.ok(feature !== null && typeof feature === 'object' && !Array.isArray(feature),
      `${packageName} feature entries must be objects`);
    assert.ok(Array.isArray(feature.capabilities),
      `${packageName} feature ${String(feature.id)} must declare capabilities (empty array allowed)`);
    for (const capability of feature.capabilities) {
      assert.equal(typeof capability, 'string', `${packageName} capabilities must be strings`);
      declared.add(capability);
    }
  }
  return [...declared];
}

test('installable package README discloses every capability declared across all features (install consent surface)', async () => {
  // The gate reads the source README.md at the package root — the same file
  // npm packs into the install tarball by default (a root README never needs
  // to be listed in package.json files[]) — so it is the consent page a user
  // actually reads at install time. Every Manager-installable package is
  // covered (not only the migration set), and capabilities are unioned
  // across ALL features: a host.filesystem.write added to a second feature
  // must not slip past the disclosure check.
  const installable = inventory.repositoryPackages.filter(entry => entry.managerInstallable);
  assert.ok(installable.length > 0, 'inventory must classify Manager-installable packages');
  for (const entry of installable) {
    // H4: README existence is an install consent-surface property of the
    // package itself, independent of what capabilities it declares — a
    // zero-capability package must still ship its (empty) disclosure page, or
    // the day a capability is added the gate would still not see any page.
    await access(new URL(`../packages/${entry.directory}/README.md`, import.meta.url))
      .catch(() => { throw new Error(`${entry.directory} must ship README.md (install consent surface)`); });
    const capabilities = await declaredCapabilities(entry.directory);
    if (capabilities.length === 0) continue;
    const readme = await readFile(new URL(`../packages/${entry.directory}/README.md`, import.meta.url), 'utf8');
    for (const capability of capabilities) {
      assert.ok(
        readme.includes(`\`${capability}\``),
        `${entry.directory} README must disclose declared capability \`${capability}\``,
      );
    }
  }
});
