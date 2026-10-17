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

test('release catalog covers admitted Manager packages and excludes held candidates', async () => {
  const mismatches = [];
  for (const entry of inventory.repositoryPackages.filter(row => row.managerInstallable)) {
    const manifest = parse(await readFile(new URL(`../packages/${entry.directory}/plugin.yaml`, import.meta.url), 'utf8'));
    const expected = entry.classification === 'manager-installable-official-public' && entry.releaseAdmission !== false;
    const present = catalog.plugins.some(row => row.pluginId === manifest.pluginId);
    if (present !== expected) mismatches.push({ directory: entry.directory, expected, present });
  }
  assert.deepEqual(mismatches, [], 'catalog must reflect the existing release disposition');
});

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
    'manager-installable-private-development',
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
      assert.ok(['manager-installable-official-public', 'manager-installable-private-development'].includes(entry.classification));
      if (entry.classification === 'manager-installable-private-development') {
        const pkg = JSON.parse(await readFile(new URL(`../packages/${entry.directory}/package.json`, import.meta.url), 'utf8'));
        assert.equal(pkg.private, true, 'a development candidate must be physically unpublished');
        assert.equal(entry.releaseAdmission, false);
        assert.equal(entry.fullInstalledAcceptance, false);
        assert.ok(entry.workSubject && entry.acceptedSource, 'unfinished work must retain its original responsibility and source');
        const manifest = parse(await readFile(new URL(`../packages/${entry.directory}/plugin.yaml`, import.meta.url), 'utf8'));
        assert.equal(catalog.plugins.some(item => item.pluginId === manifest.pluginId), false, 'a private development candidate must not silently enter the release catalog');
      }
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

test('GitHub Operations keeps reviewed implementation separate from catalog and directory acceptance', () => {
  const github = inventory.entries.find(entry => entry.id === 'github');
  assert.ok(github, 'GitHub Operations must remain in the frozen inventory');
  assert.equal(
    github.implementationStatus,
    'reviewed-alpha16-package-delivered-current-directory-host-pairing-open',
  );
  assert.equal(github.catalogAdmission, 'candidate-generated-pending-publication');
  assert.equal(inventory.localDirectoryAcceptance.directoryUiJourneyAccepted, false);
});

test('every migration target is a package-owned, cataloged artifact', async () => {
  const catalogIds = new Set(catalog.plugins.map(entry => entry.pluginId));

  const migrationEntries = inventory.entries.filter(candidate => candidate.disposition === 'migrate');
  // A generated candidate catalog is distinct from registry publication and
  // installed acceptance, but it no longer exempts a migrated package.
  const pendingCheckpointIds = migrationEntries
    .filter(candidate => candidate.catalogAdmission === 'pending-final-catalog-generation')
    .map(candidate => candidate.id);
  assert.deepEqual(pendingCheckpointIds, []);

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

test('installer READMEs use a Chinese default and independent packaged English guide', async () => {
  const installable = inventory.repositoryPackages.filter(entry => entry.managerInstallable);
  for (const entry of installable) {
    const root = new URL(`../packages/${entry.directory}/`, import.meta.url);
    const [chinese, english, pkgText] = await Promise.all([
      readFile(new URL('README.md', root), 'utf8'),
      readFile(new URL('README.en.md', root), 'utf8'),
      readFile(new URL('package.json', root), 'utf8'),
    ]);
    assert.match(chinese.split('\n')[0], /\p{Script=Han}/u,
      `${entry.directory} installer title must use the Chinese default`);
    for (const [filename, text, other] of [
      ['README.md', chinese, 'README.en.md'], ['README.en.md', english, 'README.md'],
    ]) {
      assert.ok(!text.startsWith('---\n'), `${entry.directory}/${filename} exposes internal frontmatter`);
      assert.ok(text.includes(`](${other})`), `${entry.directory}/${filename} must link the other guide`);
      const prose = text.replace(/```[\s\S]*?```|`[^`]*`/gu, '');
      if (filename === 'README.en.md') {
        assert.doesNotMatch(prose, /\p{Script=Han}/u, `${entry.directory} English guide contains Chinese prose`);
      } else {
        assert.doesNotMatch(prose, /^[A-Za-z][A-Za-z ,/()-]{30,}[.!]?$/mu,
          `${entry.directory} default guide contains untranslated English prose`);
      }
      for (const capability of await declaredCapabilities(entry.directory)) {
        assert.ok(text.includes(`\`${capability}\``), `${entry.directory}/${filename} omits ${capability}`);
      }
    }
    const pkg = JSON.parse(pkgText);
    assert.ok(pkg.files?.includes('README.en.md') || pkg.files?.includes('README*.md'),
      `${entry.directory} must package the parallel English file`);
  }
});

test('build readiness includes every manifest entrypoint, including nested runtime contributions', async () => {
  const report = JSON.parse(await readFile(
    new URL('../migration/f202-c1-build-readiness.json', import.meta.url), 'utf8',
  ));
  // Independent manifest oracle: walk every literal entrypoint declaration;
  // do not reuse the capture producer's selected contribution fields.
  function declaredEntrypoints(value) {
    if (value === null || typeof value !== 'object') return [];
    return Object.entries(value).flatMap(([key, item]) => (
      key === 'entrypoint' && typeof item === 'string'
        ? [item.replace(/^\.\//u, '')]
        : declaredEntrypoints(item)
    ));
  }
  for (const record of report.records.filter(item => item.canonicalYamlPresent)) {
    const manifest = parse(await readFile(
      new URL(`../packages/${record.directory}/plugin.yaml`, import.meta.url), 'utf8',
    ));
    const entries = new Map(record.entries.map(entry => [entry.path.replace(/^\.\//u, ''), entry]));
    const missing = new Set(record.missingEntrypoints.map(path => path.replace(/^\.\//u, '')));
    for (const path of new Set(declaredEntrypoints(manifest))) {
      assert.ok(entries.has(path), `${record.directory}: omitted manifest entrypoint ${path}`);
      assert.equal(missing.has(path), !entries.get(path).present,
        `${record.directory}: missingEntrypoints disagrees for ${path}`);
    }
  }
});


test('initial installation selects exactly the original seventeen packages without companion or fixtures', async () => {
  const selection = JSON.parse(await readFile(new URL('../catalog/initial-plugins.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(selection).sort(), ['plugins', 'schemaVersion']);
  assert.equal(selection.schemaVersion, 1);
  const originalDirectories = ['connector-dingtalk', 'connector-feishu', 'connector-telegram', 'connector-wecom-agent',
    'connector-wecom-bot', 'connector-weixin', 'connector-xiaoyi', 'github-operations', 'video-generation',
    'video-analysis', 'weixin-mp', 'wechat-visible-reader', 'personal-chrome-companion', 'enterprise-workflow',
    'collective-connector', 'genoffice-docx', 'feishu-meeting-intake'];
  const expected = await Promise.all(originalDirectories.map(async directory => {
    const manifest = parse(await readFile(new URL(`../packages/${directory}/plugin.yaml`, import.meta.url), 'utf8'));
    return manifest.pluginId;
  }));
  assert.equal(selection.plugins.length, 17);
  assert.deepEqual(selection.plugins.map(item => item.pluginId).sort(), expected.sort());
  for (const item of selection.plugins) {
    assert.deepEqual(Object.keys(item).sort(), ['enabled', 'pluginId']);
    assert.equal(item.enabled, true, 'Host config readiness gates the original initial enabled intent');
  }
});

test('every admitted public initial C1 package is covered by the protected main publisher', async () => {
  const selection = JSON.parse(await readFile(new URL('../catalog/initial-plugins.json', import.meta.url), 'utf8'));
  const selected = new Set(selection.plugins.map(item => item.pluginId));
  const workflow = parse(await readFile(new URL('../.github/workflows/contract-ci.yml', import.meta.url), 'utf8'));
  const publisher = workflow.jobs.publish;
  assert.equal(publisher.needs, 'validate');
  assert.equal(publisher.if, "github.event_name == 'push' && github.ref == 'refs/heads/main'");
  const directories = new Set(publisher.steps.filter(step => step.uses === './.github/actions/publish-prerelease')
    .map(step => step.with['package-directory']));
  const missing = [];
  for (const entry of inventory.repositoryPackages.filter(item => item.managerInstallable)) {
    const root = new URL(`../packages/${entry.directory}/`, import.meta.url);
    const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
    const manifest = parse(await readFile(new URL('plugin.yaml', root), 'utf8'));
    if (selected.has(manifest.pluginId) && pkg.private !== true && entry.releaseAdmission !== false && !directories.has(`packages/${entry.directory}`))
      missing.push(`packages/${entry.directory}`);
  }
  assert.deepEqual(missing.sort(), [], 'selected public packages cannot stop at local pack without a main publication path');
});
