import assert from 'node:assert/strict';
import test from 'node:test';

import { validateManifest } from './manifest.js';

function videoManifest() {
  return {
    pluginId: 'dev.clowder.video-analysis',
    version: '0.1.0-alpha.0',
    contractVersion: '0.1.0-beta.13',
    name: 'Video Analysis',
    configuration: [
      {
        key: 'provider',
        label: 'Provider',
        kind: 'select',
        required: true,
        options: [
          { value: 'gemini', label: 'Gemini' },
          { value: 'zhipu', label: 'Zhipu' },
        ],
      },
      { key: 'apiKey', label: 'API key', kind: 'secret', required: true },
    ],
    contributions: [
      {
        type: 'mcp',
        id: 'video-analysis-toolset',
        runtime: { transport: 'stdio', entrypoint: 'dist/mcp-server.js' },
        environment: {
          VIDEO_ANALYSIS_PROVIDER: { source: 'config', key: 'provider' },
          VIDEO_ANALYSIS_API_KEY: { source: 'secret', key: 'apiKey' },
        },
      },
      { type: 'skill', id: 'video-analysis-skill', path: 'skills/video-analysis' },
      { type: 'limb', id: 'video-analysis-limb', manifestPath: 'limbs/video-analysis.yaml' },
    ],
    features: [
      {
        id: 'analyze-video',
        name: 'Analyze video',
        resources: [{ type: 'input-source', id: 'remote-video-url' }],
        contributions: [
          { type: 'mcp', id: 'video-analysis-toolset' },
          { type: 'skill', id: 'video-analysis-skill' },
          { type: 'limb', id: 'video-analysis-limb' },
        ],
        capabilities: ['plugin.config.read', 'secret.read'],
      },
    ],
    runtime: { transport: 'builtin' },
  };
}

function docxProviderManifest() {
  return {
    pluginId: 'dev.clowder.genoffice-docx',
    version: '0.1.0-alpha.0',
    contractVersion: '0.1.0-beta.14',
    name: 'GenOffice DOCX',
    contributions: [
      {
        type: 'content-editor-provider',
        id: 'genoffice-docx',
        mediaTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
        surface: {
          entrypoint: 'renderer/index.html',
          integrity: `sha256-${'A'.repeat(43)}=`,
          sandbox: 'opaque-origin-iframe',
        },
        bridgeVersion: '1.0.0',
        operations: ['load', 'settle', 'comment', 'tracked-change'],
      },
    ],
    features: [
      {
        id: 'edit-docx',
        name: 'Edit DOCX',
        resources: [],
        contributions: [{ type: 'content-editor-provider', id: 'genoffice-docx' }],
        capabilities: [],
      },
    ],
    runtime: { transport: 'builtin' },
  };
}

test('admits typed static contributions and closed config/secret references', () => {
  assert.equal(validateManifest(videoManifest()).valid, true);

  const inlineSecret = videoManifest();
  inlineSecret.contributions[0] = {
    ...inlineSecret.contributions[0],
    environment: {
      VIDEO_ANALYSIS_API_KEY: { source: 'literal', value: 'must-not-ship' },
    },
  } as never;
  assert.equal(validateManifest(inlineSecret).valid, false);
});

test('rejects dangling contribution/config references and duplicate stable keys', () => {
  const dangling = videoManifest();
  dangling.features[0].contributions[0].id = 'missing';
  assert.equal(validateManifest(dangling).valid, false);

  const missingConfig = videoManifest();
  missingConfig.contributions[0].environment!.VIDEO_ANALYSIS_PROVIDER.key = 'missing';
  assert.equal(validateManifest(missingConfig).valid, false);

  const duplicate = videoManifest();
  duplicate.contributions.push(structuredClone(duplicate.contributions[0]));
  assert.equal(validateManifest(duplicate).valid, false);

  const duplicateConfig = videoManifest();
  duplicateConfig.configuration.push(structuredClone(duplicateConfig.configuration[0]));
  assert.equal(validateManifest(duplicateConfig).valid, false);

  const escapedPackage = videoManifest();
  escapedPackage.contributions[1].path = '../private-skill';
  assert.equal(validateManifest(escapedPackage).valid, false);

  const wrongDefaultType = videoManifest();
  wrongDefaultType.configuration.push({
    key: 'enabled',
    label: 'Enabled',
    kind: 'boolean',
    required: false,
    default: 'yes',
  } as never);
  assert.equal(validateManifest(wrongDefaultType).valid, false);

  const missingSelectDefault = videoManifest();
  (missingSelectDefault.configuration[0] as { default?: string }).default = 'missing';
  assert.equal(validateManifest(missingSelectDefault).valid, false);

  const duplicateSelectOption = videoManifest();
  const options = duplicateSelectOption.configuration[0].options;
  assert.ok(options);
  options.push(structuredClone(options[0]!));
  assert.equal(validateManifest(duplicateSelectOption).valid, false);
});

test('generated contract exposes every Train B static contribution type', async () => {
  const { generateContractSource, loadContractSchemas } = await import('../codegen/generate-contract.js');
  const source = generateContractSource(await loadContractSchemas());
  for (const type of [
    'identity',
    'schedule',
    'tool',
    'mcp',
    'skill',
    'limb',
    'webhook',
    'message-subscription',
    'service',
    'connector',
    'ui',
    'content-editor-provider',
  ]) {
    assert.match(source, new RegExp(`'${type}'`));
  }
  assert.match(source, /export type PluginCatalog =/);
});

test('admits only the closed, opaque-origin DOCX provider surface contract', () => {
  assert.equal(validateManifest(docxProviderManifest()).valid, true);

  const pathEscape = docxProviderManifest();
  pathEscape.contributions[0].surface.entrypoint = '../renderer/index.html';
  assert.equal(validateManifest(pathEscape).valid, false);

  const weakIntegrity = docxProviderManifest();
  weakIntegrity.contributions[0].surface.integrity = 'sha256-not-an-sri-digest';
  assert.equal(validateManifest(weakIntegrity).valid, false);

  const sameOrigin = docxProviderManifest();
  sameOrigin.contributions[0].surface.sandbox = 'same-origin-iframe';
  assert.equal(validateManifest(sameOrigin).valid, false);

  const wrongMedia = docxProviderManifest();
  wrongMedia.contributions[0].mediaTypes = ['text/plain'];
  assert.equal(validateManifest(wrongMedia).valid, false);

  const missingSettlement = docxProviderManifest();
  missingSettlement.contributions[0].operations = ['load', 'comment', 'tracked-change'];
  assert.equal(validateManifest(missingSettlement).valid, false);
});

test('keeps legacy resources distinct from feature-owned contributions', () => {
  const value = videoManifest();
  value.features[0].resources = [{ type: 'input-source', id: 'remote-video-url' }];
  assert.equal(validateManifest(value).valid, true);

  const duplicateReference = videoManifest();
  duplicateReference.features[0].contributions.push(
    structuredClone(duplicateReference.features[0].contributions[0]),
  );
  assert.equal(validateManifest(duplicateReference).valid, false);
});

test('validates closed UI, connector, and webhook reference shapes', () => {
  const value = videoManifest();
  const contributions = value.contributions as unknown as Array<{
    id: string;
    type: string;
    [key: string]: unknown;
  }>;
  value.configuration.push({
    key: 'webhookSecret',
    label: 'Webhook secret',
    kind: 'secret',
    required: true,
  });
  contributions.push(
    { type: 'identity', id: 'video-bot', displayName: 'Video bot' },
    {
      type: 'connector',
      id: 'video-connector',
      identityRef: 'video-bot',
      inboundMethod: 'connector.inbound',
      outboundMethod: 'connector.outbound',
    },
    {
      type: 'webhook',
      id: 'video-webhook',
      path: 'video/events',
      methods: ['POST'],
      action: { method: 'webhook.receive' },
      verificationSecretRef: 'webhookSecret',
    },
    {
      type: 'ui',
      id: 'video.open',
      kind: 'command',
      label: 'Open video analysis',
      action: { method: 'ui.open' },
    },
    {
      type: 'ui',
      id: 'video.open.menu',
      kind: 'slot-item',
      label: 'Analyze video',
      command: 'video.open',
      group: 'composer.actions',
      anchor: { position: 'after', target: 'attach' },
      when: { featureEnabled: true, requiresCapabilities: ['plugin.config.read'] },
    },
    {
      type: 'ui',
      id: 'video.result',
      kind: 'message-element',
      label: 'Video analysis result',
      elementKind: 'video-analysis-result',
      renderer: 'host.structured-result',
    },
  );
  value.features[0].contributions.push(
    { type: 'identity', id: 'video-bot' },
    { type: 'connector', id: 'video-connector' },
    { type: 'webhook', id: 'video-webhook' },
    { type: 'ui', id: 'video.open' },
    { type: 'ui', id: 'video.open.menu' },
    { type: 'ui', id: 'video.result' },
  );
  assert.equal(validateManifest(value).valid, true);

  for (const dependency of [
    { referringType: 'connector', referringId: 'video-connector', targetType: 'identity', targetId: 'video-bot' },
    { referringType: 'ui', referringId: 'video.open.menu', targetType: 'ui', targetId: 'video.open' },
  ] as const) {
    const crossFeature = structuredClone(value);
    const features = crossFeature.features as unknown as Array<{
      id: string;
      name: string;
      resources: unknown[];
      contributions: Array<{ type: string; id: string }>;
      capabilities: string[];
    }>;
    const targetIndex = features[0]!.contributions.findIndex(
      (reference) => reference.type === dependency.targetType && reference.id === dependency.targetId,
    );
    assert.notEqual(targetIndex, -1);
    const [target] = features[0]!.contributions.splice(targetIndex, 1);
    assert.ok(target);
    features.push({
      id: `${dependency.referringId}-dependency-owner`,
      name: 'Foreign dependency owner',
      resources: [],
      contributions: [target],
      capabilities: [],
    });

    const result = validateManifest(crossFeature);
    assert.equal(result.valid, false, `${dependency.referringType} dependency must stay feature-local`);
    if (!result.valid) assert.equal(result.errors[0]?.keyword, 'sameFeatureOwner');
  }

  const forgedSecret = structuredClone(value);
  const webhook = (forgedSecret.contributions as unknown as typeof contributions).find(
    (entry) => entry.id === 'video-webhook',
  );
  assert.equal(webhook?.type, 'webhook');
  assert.ok(webhook);
  webhook.verificationSecretRef = 'provider';
  assert.equal(validateManifest(forgedSecret).valid, false);

  const openWhenExpression = structuredClone(value);
  const slot = (openWhenExpression.contributions as unknown as typeof contributions).find(
    (entry) => entry.id === 'video.open.menu',
  );
  assert.ok(slot);
  assert.equal(slot.type, 'ui');
  assert.equal(slot.kind, 'slot-item');
  slot.when = 'feature.enabled && arbitrary.expression' as never;
  assert.equal(validateManifest(openWhenExpression).valid, false);

  const absoluteWebhook = structuredClone(value);
  const absoluteWebhookContribution = (
    absoluteWebhook.contributions as unknown as typeof contributions
  ).find((entry) => entry.id === 'video-webhook');
  assert.ok(absoluteWebhookContribution);
  absoluteWebhookContribution.path = '/video/events';
  assert.equal(validateManifest(absoluteWebhook).valid, false);
});

test('requires explicit bounded policy for static schedules', () => {
  const value = videoManifest();
  value.contributions.push({
    type: 'schedule',
    id: 'refresh-video-index',
    schedule: { kind: 'interval', everyMs: 60_000 },
    action: { method: 'video.refresh' },
    policy: { overlap: 'skip', timeoutMs: 30_000 },
  } as never);
  value.features[0].contributions.push({
    type: 'schedule',
    id: 'refresh-video-index',
  });
  assert.equal(validateManifest(value).valid, true);

  const missingPolicy = structuredClone(value);
  const schedule = (
    missingPolicy.contributions as unknown as Array<Record<string, unknown>>
  ).find((entry) => entry.id === 'refresh-video-index');
  assert.ok(schedule);
  delete schedule.policy;
  assert.equal(validateManifest(missingPolicy).valid, false);

  const unboundedTimeout = structuredClone(value);
  const unboundedSchedule = (
    unboundedTimeout.contributions as unknown as Array<Record<string, unknown>>
  ).find((entry) => entry.id === 'refresh-video-index');
  assert.ok(unboundedSchedule);
  unboundedSchedule.policy = { overlap: 'skip', timeoutMs: 86_400_001 };
  assert.equal(validateManifest(unboundedTimeout).valid, false);
});
