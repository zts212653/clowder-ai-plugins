import assert from 'node:assert/strict';
import test from 'node:test';

import type { StaticContribution } from '@clowder-ai/plugin-contract';

import {
  ContributionConflictError,
  FeatureContextRevokedError,
  createFeatureContextSession,
  definePlugin,
  type FeatureBinding,
  type FeatureHostAdapter,
  type HostContributionReceipt,
} from './feature-context.js';

const BINDING: FeatureBinding = {
  pluginInstanceId: 'instance-1',
  featureId: 'feature-1',
  packageRevision: 'package-1',
  integrityEpoch: 4,
  activationRevision: 7,
  grantRevision: 3,
  grantedCapabilities: [],
  executionLease: 'opaque-host-signed-lease',
};

function manifest() {
  return {
    pluginId: 'dev.clowder.fixture',
    version: '0.1.0',
    contractVersion: '0.1.0-beta.13',
    name: 'Fixture',
    contributions: [{ type: 'identity', id: 'cat', displayName: 'Fixture cat' }],
    features: [
      {
        id: 'feature-1',
        name: 'Feature one',
        resources: [],
        contributions: [{ type: 'identity', id: 'cat' }],
        capabilities: [],
      },
    ],
    runtime: { transport: 'stdio', entrypoint: 'dist/entrypoint.js' },
  };
}

class RecordingAdapter implements FeatureHostAdapter {
  readonly calls: Array<{ operation: string; binding: FeatureBinding; value?: unknown }> = [];
  failNextDispose = false;
  #revision = 0;

  async readConfig(binding: FeatureBinding, key: string): Promise<unknown> {
    this.calls.push({ operation: 'config.get', binding, value: key });
    return key === 'mode' ? 'safe' : undefined;
  }

  async readSecret(binding: FeatureBinding, key: string): Promise<string> {
    this.calls.push({ operation: 'secrets.get', binding, value: key });
    return `secret:${key}`;
  }

  async readState(binding: FeatureBinding, key: string): Promise<unknown> {
    this.calls.push({ operation: 'state.get', binding, value: key });
    return undefined;
  }

  async writeState(binding: FeatureBinding, key: string, value: unknown): Promise<void> {
    this.calls.push({ operation: 'state.set', binding, value: { key, value } });
  }

  async registerContribution(
    binding: FeatureBinding,
    contribution: StaticContribution,
  ): Promise<HostContributionReceipt> {
    this.calls.push({ operation: 'register', binding, value: contribution });
    this.#revision += 1;
    return { registrationId: `registration-${this.#revision}`, registryRevision: this.#revision };
  }

  async disposeContribution(
    binding: FeatureBinding,
    receipt: HostContributionReceipt,
  ): Promise<void> {
    this.calls.push({ operation: 'dispose', binding, value: receipt });
    if (this.failNextDispose) {
      this.failNextDispose = false;
      throw new Error('transient disposal failure');
    }
  }
}

class PausingDisposeAdapter extends RecordingAdapter {
  readonly disposeStarted: Promise<void>;
  readonly #releaseDispose: Promise<void>;
  #markDisposeStarted!: () => void;
  #finishDispose!: () => void;

  constructor() {
    super();
    this.disposeStarted = new Promise((resolve) => {
      this.#markDisposeStarted = resolve;
    });
    this.#releaseDispose = new Promise((resolve) => {
      this.#finishDispose = resolve;
    });
  }

  releaseDispose(): void {
    this.#finishDispose();
  }

  override async disposeContribution(
    binding: FeatureBinding,
    receipt: HostContributionReceipt,
  ): Promise<void> {
    this.calls.push({ operation: 'dispose', binding, value: receipt });
    this.#markDisposeStarted();
    await this.#releaseDispose;
  }
}

test('definePlugin validates the manifest and rejects undeclared activators', () => {
  const source = manifest();
  const defined = definePlugin({
    manifest: source,
    activate: {
      'feature-1': async (context) => {
        await context.config.get('mode');
      },
    },
  });
  assert.equal(defined.manifest.pluginId, 'dev.clowder.fixture');
  source.name = 'mutated after validation';
  assert.equal(defined.manifest.name, 'Fixture');
  assert.equal(Object.isFrozen(defined.manifest.features[0]), true);

  assert.throws(
    () => definePlugin({ manifest: manifest(), activate: { missing: async () => undefined } }),
    /activator.*missing.*not declared/i,
  );
});

test('feature context keeps authority in the Host binding and namespaces typed registrations', async () => {
  const adapter = new RecordingAdapter();
  const { context } = createFeatureContextSession(BINDING, adapter);

  assert.equal(await context.config.get('mode'), 'safe');
  assert.equal(await context.secrets.get('apiKey'), 'secret:apiKey');
  await context.state.set('cursor', { value: 1 });

  const registration = await context.identity.register({ id: 'cat', displayName: 'Fixture cat' });
  assert.equal(registration.key, 'identity:cat');
  const call = adapter.calls.find((entry) => entry.operation === 'register');
  assert.deepEqual(call?.binding, BINDING);
  assert.deepEqual(call?.value, {
    type: 'identity',
    id: 'cat',
    displayName: 'Fixture cat',
  });
  assert.equal('pluginId' in (call?.value as object), false);
  assert.equal('featureId' in (call?.value as object), false);
});

test('registration snapshots nested payloads before crossing the Host boundary', async () => {
  const adapter = new RecordingAdapter();
  const { context } = createFeatureContextSession(BINDING, adapter);
  const inputSchema = {
    type: 'object',
    properties: { prompt: { type: 'string' } },
  };

  await context.tools.register({
    id: 'analyze',
    name: 'analyze',
    inputSchema,
    action: { method: 'video.analyze' },
  });
  inputSchema.properties.prompt.type = 'number';

  const call = adapter.calls.find((entry) => entry.operation === 'register');
  const contribution = call?.value as StaticContribution;
  assert.equal(contribution.type, 'tool');
  if (contribution.type !== 'tool') return;
  assert.equal(
    (contribution.inputSchema.properties as Record<string, { type: string }>).prompt?.type,
    'string',
  );
  assert.equal(Object.isFrozen(contribution.inputSchema.properties), true);
});

test('UI registrar preserves every variant-specific typed input', async () => {
  const adapter = new RecordingAdapter();
  const { context } = createFeatureContextSession(BINDING, adapter);

  await context.ui.register({
    id: 'open-settings',
    kind: 'command',
    label: 'Open settings',
    action: { method: 'settings.open' },
  });
  await context.ui.register({
    id: 'settings-menu',
    kind: 'slot-item',
    label: 'Settings',
    command: 'open-settings',
    group: 'navigation',
  });
  await context.ui.register({
    id: 'analysis-card',
    kind: 'message-element',
    label: 'Analysis card',
    elementKind: 'video-analysis',
    renderer: 'video-analysis-card',
  });

  assert.deepEqual(
    adapter.calls
      .filter((entry) => entry.operation === 'register')
      .map((entry) => entry.value),
    [
      {
        type: 'ui',
        id: 'open-settings',
        kind: 'command',
        label: 'Open settings',
        action: { method: 'settings.open' },
      },
      {
        type: 'ui',
        id: 'settings-menu',
        kind: 'slot-item',
        label: 'Settings',
        command: 'open-settings',
        group: 'navigation',
      },
      {
        type: 'ui',
        id: 'analysis-card',
        kind: 'message-element',
        label: 'Analysis card',
        elementKind: 'video-analysis',
        renderer: 'video-analysis-card',
      },
    ],
  );
});

test('same-key retries are idempotent, conflicts fail closed, and disposal runs once', async () => {
  const adapter = new RecordingAdapter();
  const { context } = createFeatureContextSession(BINDING, adapter);
  const input = { id: 'cat', displayName: 'Fixture cat' };

  const first = await context.identity.register(input);
  const retry = await context.identity.register({ ...input });
  assert.equal(retry, first);
  assert.equal(adapter.calls.filter((entry) => entry.operation === 'register').length, 1);

  await assert.rejects(
    context.identity.register({ ...input, displayName: 'Different' }),
    ContributionConflictError,
  );
  await first.dispose();
  await first.dispose();
  assert.equal(adapter.calls.filter((entry) => entry.operation === 'dispose').length, 1);
});

test('same-payload registration waits for overlapping disposal and creates a fresh receipt', async () => {
  const adapter = new PausingDisposeAdapter();
  const { context } = createFeatureContextSession(BINDING, adapter);
  const input = { id: 'cat', displayName: 'Fixture cat' };
  const first = await context.identity.register(input);

  const disposal = first.dispose();
  await adapter.disposeStarted;
  let replacementResolved = false;
  const replacementPromise = context.identity.register(input).then((registration) => {
    replacementResolved = true;
    return registration;
  });
  await Promise.resolve();
  assert.equal(replacementResolved, false);

  adapter.releaseDispose();
  await disposal;
  const replacement = await replacementPromise;
  assert.notEqual(replacement, first);
  assert.notEqual(replacement.receipt.registrationId, first.receipt.registrationId);
  assert.equal(adapter.calls.filter((entry) => entry.operation === 'register').length, 2);
  assert.equal(adapter.calls.filter((entry) => entry.operation === 'dispose').length, 1);
});

test('revocation disposes owned registrations and rejects stale context while leaving siblings live', async () => {
  const adapter = new RecordingAdapter();
  const first = createFeatureContextSession(BINDING, adapter);
  const sibling = createFeatureContextSession(
    { ...BINDING, featureId: 'feature-2', activationRevision: 8, executionLease: 'sibling-lease' },
    adapter,
  );

  await first.context.identity.register({ id: 'cat', displayName: 'Fixture cat' });
  await first.revoke();
  await first.revoke();
  await assert.rejects(first.context.config.get('mode'), FeatureContextRevokedError);
  await assert.rejects(
    first.context.identity.register({ id: 'late', displayName: 'Late' }),
    FeatureContextRevokedError,
  );

  assert.equal(await sibling.context.config.get('mode'), 'safe');
  assert.equal(adapter.calls.filter((entry) => entry.operation === 'dispose').length, 1);
});

test('failed disposal keeps the revoked session retryable without reopening it', async () => {
  const adapter = new RecordingAdapter();
  const session = createFeatureContextSession(BINDING, adapter);
  await session.context.identity.register({ id: 'cat', displayName: 'Fixture cat' });
  adapter.failNextDispose = true;

  await assert.rejects(session.revoke(), /transient disposal failure/);
  await assert.rejects(session.context.config.get('mode'), FeatureContextRevokedError);
  await session.revoke();

  assert.equal(adapter.calls.filter((entry) => entry.operation === 'dispose').length, 2);
});
