import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import type { PluginManifest } from '../generated/contract.generated.js';
import { validateManifest } from './manifest.js';

function variantManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pluginId: 'dev.clowder.fixture.variants',
    version: '0.1.0',
    contractVersion: '0.2.0',
    name: 'Variant fixture',
    features: [{ id: 'echo', name: 'Echo', resources: [], }],
    runtime: { transport: 'builtin' },
    configuration: [
      { key: 'appId', label: 'App ID', kind: 'string', required: true },
      {
        key: 'connectionMode',
        label: 'Mode',
        kind: 'select',
        required: true,
        default: 'webhook',
        options: [
          { value: 'webhook', label: 'Webhook' },
          { value: 'websocket', label: 'Websocket' },
        ],
      },
      { key: 'verificationToken', label: 'Token', kind: 'secret', required: true },
    ],
    configurationVariants: {
      discriminator: 'connectionMode',
      branches: [
        {
          id: 'webhook',
          when: { properties: { connectionMode: { const: 'webhook' } } },
          fields: ['verificationToken'],
        },
        {
          id: 'websocket',
          when: { properties: { connectionMode: { const: 'websocket' } } },
          fields: [],
        },
      ],
    },
    ...overrides,
  };
}

function singleError(manifest: Record<string, unknown>) {
  const result = validateManifest(manifest);
  assert.equal(result.valid, false, JSON.stringify(result));
  assert.equal(result.errors.length, 1);
  return result.errors[0]!;
}

test('a conforming 0.2.0 manifest with configurationVariants validates', () => {
  const result = validateManifest(variantManifest());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('newer contracts retain configurationVariants used by the installed Collective package', () => {
  for (const contractVersion of ['0.3.0', '0.3.1-candidate.0', '0.3.2-candidate.0']) {
    const result = validateManifest(variantManifest({ contractVersion }));
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  }
});

test('configurationVariants requires contractVersion 0.2.0 or newer', () => {
  const error = singleError(variantManifest({ contractVersion: '0.1.0' }));
  assert.equal(error.keyword, 'contractVersion');
  assert.equal(error.instancePath, '/configurationVariants');
});

test('the discriminator must reference a declared configuration field', () => {
  const manifest = variantManifest();
  (manifest['configurationVariants'] as { discriminator: string }).discriminator = 'missing';
  const error = singleError(manifest);
  assert.equal(error.keyword, 'discriminatorDeclaredKey');
});

test('the discriminator must reference a select field', () => {
  const manifest = variantManifest();
  (manifest['configurationVariants'] as { discriminator: string }).discriminator = 'appId';
  const error = singleError(manifest);
  assert.equal(error.keyword, 'discriminatorSelectKey');
});

test('branch when.properties may only constrain the discriminator key', () => {
  const manifest = variantManifest();
  const branches = (manifest['configurationVariants'] as { branches: Array<{ when: { properties: Record<string, unknown> } }> }).branches;
  branches[0]!.when.properties = {
    connectionMode: { const: 'webhook' },
    appId: { const: 'x' },
  };
  const error = singleError(manifest);
  assert.equal(error.keyword, 'whenSingleDiscriminator');
});

test('branch discriminator constraint must use exactly one of const or enum', () => {
  const manifest = variantManifest();
  const branches = (manifest['configurationVariants'] as { branches: Array<{ when: { properties: Record<string, unknown> } }> }).branches;
  branches[0]!.when.properties = { connectionMode: { const: 'webhook', enum: ['webhook'] } };
  assert.equal(singleError(manifest).keyword, 'whenConstOrEnum');

  const withoutEither = variantManifest();
  const branches2 = (withoutEither['configurationVariants'] as { branches: Array<{ when: { properties: Record<string, unknown> } }> }).branches;
  branches2[0]!.when.properties = { connectionMode: { minLength: 1 } };
  assert.equal(singleError(withoutEither).keyword, 'whenConstOrEnum');
});

test('branch constraint values must be declared discriminator options', () => {
  const manifest = variantManifest();
  const branches = (manifest['configurationVariants'] as { branches: Array<{ when: { properties: Record<string, unknown> } }> }).branches;
  branches[0]!.when.properties = { connectionMode: { const: 'polling' } };
  const error = singleError(manifest);
  assert.equal(error.keyword, 'whenDeclaredOption');
});

test('every option value must be matched by exactly one branch (completeness)', () => {
  const manifest = variantManifest();
  const variants = manifest['configurationVariants'] as { branches: unknown[] };
  variants.branches = variants.branches.slice(0, 1);
  const error = singleError(manifest);
  assert.equal(error.keyword, 'completeExclusiveBranches');
  assert.match(error.message, /websocket/);
});

test('every option value must be matched by exactly one branch (exclusivity)', () => {
  const manifest = variantManifest();
  const variants = manifest['configurationVariants'] as {
    branches: Array<{ id: string; when: unknown; fields: string[] }>;
  };
  variants.branches.push({
    id: 'webhook-again',
    when: { properties: { connectionMode: { enum: ['webhook'] } } },
    fields: [],
  });
  const error = singleError(manifest);
  assert.equal(error.keyword, 'completeExclusiveBranches');
  assert.match(error.message, /webhook/);
});

test('an enum branch covering the remaining options satisfies completeness', () => {
  const manifest = variantManifest();
  const variants = manifest['configurationVariants'] as {
    branches: Array<{ id: string; when: unknown; fields: string[] }>;
  };
  variants.branches[1] = {
    id: 'rest',
    when: { properties: { connectionMode: { enum: ['websocket'] } } },
    fields: [],
  };
  assert.equal(validateManifest(manifest).valid, true);
});

test('branch fields must reference declared configuration keys', () => {
  const manifest = variantManifest();
  const variants = manifest['configurationVariants'] as { branches: Array<{ fields: string[] }> };
  variants.branches[0]!.fields = ['missingToken'];
  const error = singleError(manifest);
  assert.equal(error.keyword, 'declaredBranchField');
});

test('branch fields must not include the discriminator itself', () => {
  const manifest = variantManifest();
  const variants = manifest['configurationVariants'] as { branches: Array<{ fields: string[] }> };
  variants.branches[0]!.fields = ['connectionMode'];
  const error = singleError(manifest);
  assert.equal(error.keyword, 'discriminatorNotBranchField');
});

test('branch ids must be unique', () => {
  const manifest = variantManifest();
  const variants = manifest['configurationVariants'] as { branches: Array<{ id: string }> };
  variants.branches[1]!.id = 'webhook';
  const error = singleError(manifest);
  assert.equal(error.keyword, 'uniqueBranchIds');
});

test('a field may be shared by several branches', () => {
  const manifest = variantManifest({
    configuration: [
      {
        key: 'authType',
        label: 'Auth',
        kind: 'select',
        required: true,
        options: [
          { value: 'apikey', label: 'API Key' },
          { value: 'jwt-hs256', label: 'JWT' },
          { value: 'hmac-sha256-v4', label: 'HMAC' },
        ],
      },
      { key: 'apiKey', label: 'API Key', kind: 'secret', required: true },
      { key: 'accessKey', label: 'Access Key', kind: 'secret', required: true },
      { key: 'secretKey', label: 'Secret Key', kind: 'secret', required: true },
    ],
    configurationVariants: {
      discriminator: 'authType',
      branches: [
        {
          id: 'apikey',
          when: { properties: { authType: { const: 'apikey' } } },
          fields: ['apiKey'],
        },
        {
          id: 'jwt',
          when: { properties: { authType: { enum: ['jwt-hs256'] } } },
          fields: ['accessKey', 'secretKey'],
        },
        {
          id: 'hmac',
          when: { properties: { authType: { enum: ['hmac-sha256-v4'] } } },
          fields: ['accessKey', 'secretKey'],
        },
      ],
    },
  });
  assert.equal(validateManifest(manifest).valid, true);
});

test('legacy 0.1.0 manifests without variants keep validating unchanged', () => {
  const legacy = variantManifest();
  delete legacy['configurationVariants'];
  legacy['contractVersion'] = '0.1.0';
  const result = validateManifest(legacy);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal((result as { manifest: PluginManifest }).manifest.contractVersion, '0.1.0');
});

test('branch when rejects unsupported JSON Schema keywords such as not', () => {
  const manifest = variantManifest();
  const variants = manifest['configurationVariants'] as {
    branches: Array<{ when: Record<string, unknown> }>;
  };
  variants.branches[0]!.when = {
    not: {},
    properties: { connectionMode: { const: 'webhook' } },
  };
  const error = singleError(manifest);
  assert.equal(error.keyword, 'whenConstrainedKeywords');
  assert.equal(error.instancePath, '/configurationVariants/branches/0/when');
});

test('branch when rejects a non-object when fragment', () => {
  const manifest = variantManifest();
  const variants = manifest['configurationVariants'] as {
    branches: Array<{ when: Record<string, unknown> }>;
  };
  variants.branches[0]!.when = null as unknown as Record<string, unknown>;
  // The generated contract schema rejects non-object `when` at the structural
  // layer before semantic variant checks run.
  const error = singleError(manifest);
  assert.equal(error.keyword, 'type');
  assert.equal(error.instancePath, '/configurationVariants/branches/0/when');
});

test('duplicate branch enum values return an invalid result without throwing', () => {
  const manifest = variantManifest();
  const variants = manifest['configurationVariants'] as {
    branches: Array<{ when: { properties: Record<string, unknown> } }>;
  };
  variants.branches[0]!.when.properties = {
    connectionMode: { enum: ['webhook', 'webhook'] },
  };
  const error = singleError(manifest);
  assert.equal(error.keyword, 'whenUniqueOptions');
});

test('manifest admission compiles each branch only once', (t) => {
  const Ajv2020 = createRequire(import.meta.url)('ajv/dist/2020') as {
    prototype: { compile: (schema: unknown) => unknown };
  };
  const compile = t.mock.method(Ajv2020.prototype, 'compile');
  const values = Array.from({ length: 8 }, (_, index) => `mode${index}`);
  const manifest = variantManifest({
    configuration: [{
      key: 'mode', kind: 'select', label: 'Mode', required: true,
      options: values.map((value) => ({ value, label: value })),
    }],
    configurationVariants: {
      discriminator: 'mode',
      branches: values.map((value) => ({
        id: value, when: { properties: { mode: { const: value } } }, fields: [],
      })),
    },
  });
  const result = validateManifest(manifest);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(compile.mock.callCount(), values.length);
});
