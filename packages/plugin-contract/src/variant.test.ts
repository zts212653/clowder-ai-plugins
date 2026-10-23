import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import AjvPkg from 'ajv';
import addFormatsPkg from 'ajv-formats';
import type { ValidateFunction } from 'ajv';

const AjvCtor = AjvPkg as unknown as new (options?: Record<string, unknown>) => {
  compile: (schema: unknown) => ValidateFunction;
};

import type { PluginManifest } from './generated/contract.generated.js';
import {
  buildVariantValidationSchema,
  coerceStoredValues,
  computeEffectiveConfiguration,
  evaluateFieldRequiredness,
  resolveConfigurationVariant,
} from './variant.js';

const feishuLike = {
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
    { key: 'groupBotMentionsJson', label: 'Mentions', kind: 'string', required: false, hidden: true },
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
} as unknown as PluginManifest;

const videoGenLike = {
  ...feishuLike,
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
    { key: 'model', label: 'Model', kind: 'string', required: false },
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
} as unknown as PluginManifest;

test('resolveConfigurationVariant selects the matching branch', () => {
  assert.deepEqual(
    resolveConfigurationVariant(feishuLike, { connectionMode: 'webhook' }),
    { status: 'selected', branchId: 'webhook' },
  );
  assert.deepEqual(
    resolveConfigurationVariant(feishuLike, { connectionMode: 'websocket' }),
    { status: 'selected', branchId: 'websocket' },
  );
});

test('resolveConfigurationVariant matches enum constraints across shared branches', () => {
  assert.deepEqual(
    resolveConfigurationVariant(videoGenLike, { authType: 'jwt-hs256' }),
    { status: 'selected', branchId: 'jwt' },
  );
  assert.deepEqual(
    resolveConfigurationVariant(videoGenLike, { authType: 'hmac-sha256-v4' }),
    { status: 'selected', branchId: 'hmac' },
  );
});

test('resolveConfigurationVariant falls back to the discriminator field default', () => {
  assert.deepEqual(resolveConfigurationVariant(feishuLike, {}), {
    status: 'selected',
    branchId: 'webhook',
  });
  assert.deepEqual(resolveConfigurationVariant(feishuLike, { connectionMode: undefined }), {
    status: 'selected',
    branchId: 'webhook',
  });
  const { default: _omit, ...noDefaultMode } = feishuLike.configuration![1]!;
  const withoutDefault = {
    ...feishuLike,
    configuration: feishuLike.configuration!.map((field, index) =>
      index === 1 ? noDefaultMode : field,
    ),
  } as unknown as PluginManifest;
  assert.deepEqual(resolveConfigurationVariant(withoutDefault, {}), { status: 'unselected' });
});

test('resolveConfigurationVariant reports invalid for a value no branch matches', () => {
  assert.deepEqual(resolveConfigurationVariant(feishuLike, { connectionMode: 'polling' }), {
    status: 'invalid',
    value: 'polling',
  });
});

test('resolveConfigurationVariant stays unselected for manifests without variants', () => {
  const { configurationVariants: _omit, ...legacy } = feishuLike as Record<string, unknown>;
  assert.deepEqual(
    resolveConfigurationVariant(legacy as unknown as PluginManifest, { connectionMode: 'webhook' }),
    { status: 'unselected' },
  );
});

test('computeEffectiveConfiguration applies declared defaults without stored values', () => {
  const { resolution, effectiveValues } = computeEffectiveConfiguration(feishuLike, {});
  assert.deepEqual(resolution, { status: 'selected', branchId: 'webhook' });
  assert.equal(effectiveValues['connectionMode'], 'webhook');
  assert.equal(effectiveValues['appId'], undefined);
  assert.equal('verificationToken' in effectiveValues, true);
  assert.equal(effectiveValues['verificationToken'], undefined);
});

test('computeEffectiveConfiguration keeps common fields plus the active branch only', () => {
  const { resolution, effectiveValues } = computeEffectiveConfiguration(feishuLike, {
    appId: 'app-1',
    connectionMode: 'websocket',
    verificationToken: 'stale-token',
  });
  assert.deepEqual(resolution, { status: 'selected', branchId: 'websocket' });
  assert.equal(effectiveValues['appId'], 'app-1');
  assert.equal(effectiveValues['connectionMode'], 'websocket');
  assert.equal('verificationToken' in effectiveValues, false);
});

test('computeEffectiveConfiguration excludes inactive branch values even when stored', () => {
  const { effectiveValues } = computeEffectiveConfiguration(videoGenLike, {
    authType: 'apikey',
    apiKey: 'key',
    accessKey: 'access',
    secretKey: 'secret',
    model: 'cogvideox',
  });
  assert.equal(effectiveValues['apiKey'], 'key');
  assert.equal('accessKey' in effectiveValues, false);
  assert.equal('secretKey' in effectiveValues, false);
  assert.equal(effectiveValues['model'], 'cogvideox');
});

test('computeEffectiveConfiguration serves a field shared by several branches in each of them', () => {
  const jwt = computeEffectiveConfiguration(videoGenLike, {
    authType: 'jwt-hs256',
    accessKey: 'access',
    secretKey: 'secret',
  });
  assert.equal(jwt.effectiveValues['accessKey'], 'access');
  assert.equal(jwt.effectiveValues['secretKey'], 'secret');
  assert.equal('apiKey' in jwt.effectiveValues, false);

  const hmac = computeEffectiveConfiguration(videoGenLike, {
    authType: 'hmac-sha256-v4',
    accessKey: 'access',
    secretKey: 'secret',
  });
  assert.equal(hmac.effectiveValues['accessKey'], 'access');
  assert.equal(hmac.effectiveValues['secretKey'], 'secret');
});

test('computeEffectiveConfiguration does not fall back on an invalid discriminator value', () => {
  const { resolution, effectiveValues } = computeEffectiveConfiguration(feishuLike, {
    appId: 'app-1',
    connectionMode: 'polling',
  });
  assert.deepEqual(resolution, { status: 'invalid', value: 'polling' });
  assert.equal(effectiveValues['connectionMode'], 'polling');
  assert.equal(effectiveValues['appId'], 'app-1');
  assert.equal('verificationToken' in effectiveValues, false);
});

test('computeEffectiveConfiguration leaves legacy manifests fully common', () => {
  const legacy = {
    pluginId: 'dev.clowder.fixture.legacy',
    version: '0.1.0',
    contractVersion: '0.1.0',
    name: 'Legacy',
    features: [{ id: 'echo', name: 'Echo', resources: [], }],
    runtime: { transport: 'builtin' },
    configuration: [
      { key: 'appId', label: 'App ID', kind: 'string', required: true },
      { key: 'token', label: 'Token', kind: 'secret', required: true },
    ],
  } as unknown as PluginManifest;
  const { resolution, effectiveValues } = computeEffectiveConfiguration(legacy, {
    appId: 'app-1',
    token: 'tok',
  });
  assert.deepEqual(resolution, { status: 'unselected' });
  assert.deepEqual(effectiveValues, { appId: 'app-1', token: 'tok' });
});

test('buildVariantValidationSchema compiles oneOf branches with discriminator-required fields', () => {
  const schema = buildVariantValidationSchema(feishuLike);
  assert.equal(schema['type'], 'object');
  const oneOf = schema['oneOf'] as Array<Record<string, unknown>>;
  assert.equal(oneOf.length, 2);

  const webhook = oneOf[0]!;
  assert.deepEqual(webhook['required'], ['connectionMode', 'verificationToken']);
  const webhookProperties = webhook['properties'] as Record<string, unknown>;
  assert.deepEqual(webhookProperties['connectionMode'], { const: 'webhook' });
  assert.deepEqual(webhookProperties['verificationToken'], { type: 'string', minLength: 1, pattern: '\\S' });

  const websocket = oneOf[1]!;
  assert.deepEqual(websocket['required'], ['connectionMode']);
  assert.equal(
    'verificationToken' in (websocket['properties'] as Record<string, unknown>),
    false,
  );
});

test('buildVariantValidationSchema keeps required:false branch fields optional', () => {
  const manifest = structuredClone(videoGenLike) as PluginManifest;
  const apiKey = manifest.configuration!.find((field) => field.key === 'apiKey')!;
  (apiKey as { required: boolean }).required = false;
  const schema = buildVariantValidationSchema(manifest);
  const oneOf = schema['oneOf'] as Array<Record<string, unknown>>;
  assert.ok(oneOf.every((branch) => !(branch['required'] as string[]).includes('apiKey')));

  (apiKey as { required: boolean }).required = true;
  const requiredSchema = buildVariantValidationSchema(manifest);
  const requiredOneOf = requiredSchema['oneOf'] as Array<Record<string, unknown>>;
  const apikeyBranch = requiredOneOf.find((branch) =>
    (branch['required'] as string[]).includes('apiKey'),
  );
  assert.ok(apikeyBranch);
  assert.deepEqual((apikeyBranch!['properties'] as Record<string, unknown>)['apiKey'], {
    type: 'string',
    minLength: 1,
    pattern: '\\S',
  });
  assert.equal(
    requiredOneOf.filter((branch) => (branch['required'] as string[]).includes('apiKey'))
      .length,
    1,
  );
});

test('buildVariantValidationSchema compiles requiredWhen discriminator gates as if/then in the owning branch', () => {
  const manifest = structuredClone(videoGenLike) as PluginManifest;
  const apiKey = manifest.configuration!.find((field) => field.key === 'apiKey')!;
  (apiKey as { required: boolean; requiredWhen?: unknown }).required = false;
  (apiKey as { requiredWhen?: unknown }).requiredWhen = { key: 'authType', value: 'apikey' };
  const oneOf = buildVariantValidationSchema(manifest)['oneOf'] as Array<Record<string, unknown>>;
  const apikeyBranch = oneOf.find((branch) => branch['allOf'] !== undefined);
  assert.ok(apikeyBranch);
  assert.deepEqual(apikeyBranch!['required'], ['authType']);
  const allOf = apikeyBranch!['allOf'] as Array<Record<string, unknown>>;
  assert.equal(allOf.length, 1);
  assert.deepEqual(allOf[0]!['if'], {
    properties: { authType: { enum: ['apikey'] } },
    required: ['authType'],
  });
  assert.deepEqual((allOf[0]!['then'] as Record<string, unknown>)['required'], ['apiKey']);
  // The other branches keep their own plain required fields and carry no gate.
  const jwtBranch = oneOf.find((branch) =>
    (branch['required'] as string[]).includes('accessKey'),
  );
  assert.ok(jwtBranch);
  assert.equal('allOf' in jwtBranch!, false);
});

test('buildVariantValidationSchema returns common-field constraints for legacy manifests', () => {
  const legacy = structuredClone(feishuLike) as Record<string, unknown>;
  delete legacy['configurationVariants'];
  const schema = buildVariantValidationSchema(legacy as unknown as PluginManifest);
  assert.equal(schema['type'], 'object');
  assert.deepEqual(schema['properties'], {
    appId: { type: 'string', minLength: 1, pattern: '\\S' },
    connectionMode: { type: 'string', enum: ['webhook', 'websocket'] },
    verificationToken: { type: 'string', minLength: 1, pattern: '\\S' },
    groupBotMentionsJson: { type: 'string', minLength: 1, pattern: '\\S' },
  });
  assert.deepEqual(schema['required'], ['appId', 'connectionMode', 'verificationToken']);
  assert.equal('oneOf' in schema, false);
});

test('variant module stays browser-safe: no ajv or node: imports', async () => {
  const source = await readFile(new URL('./variant.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from\s+['"](?:node:|\.)[^'"]*ajv/);
  assert.doesNotMatch(source, /from\s+['"]node:/);
  assert.doesNotMatch(source, /require\(/);
});

test('evaluateFieldRequiredness: requiredWhen replaces the required flag with strict matching', () => {
  const base = { key: 'token', label: 'T', kind: 'secret', required: true } as const;
  const conditional = {
    ...base,
    requiredWhen: { key: 'mode', value: ['a', 1] as const },
  } as unknown as Parameters<typeof evaluateFieldRequiredness>[0];

  assert.equal(evaluateFieldRequiredness(conditional, { mode: 'a' }), true);
  assert.equal(evaluateFieldRequiredness(conditional, { mode: 1 }), true);
  assert.equal(evaluateFieldRequiredness(conditional, { mode: 'b' }), false);
  assert.equal(evaluateFieldRequiredness(conditional, { mode: undefined }), false);
  // No stringification: '1' must not satisfy the numeric condition 1.
  assert.equal(evaluateFieldRequiredness(conditional, { mode: '1' }), false);
  // required:true is fully overridden while the condition does not hold.
  assert.equal(evaluateFieldRequiredness(conditional, {}), false);

  const plain = { key: 'appId', label: 'A', kind: 'string', required: true } as const;
  assert.equal(
    evaluateFieldRequiredness(plain as unknown as Parameters<typeof evaluateFieldRequiredness>[0], {}),
    true,
  );
  const optional = { key: 'x', label: 'X', kind: 'string', required: false } as const;
  assert.equal(
    evaluateFieldRequiredness(optional as unknown as Parameters<typeof evaluateFieldRequiredness>[0], {}),
    false,
  );
});

const enumBranchManifest = {
  pluginId: 'dev.clowder.fixture.enum-branch',
  version: '0.1.0',
  contractVersion: '0.2.0',
  name: 'Enum branch',
  features: [{ id: 'echo', name: 'Echo', resources: [], }],
  runtime: { transport: 'builtin' },
  configuration: [
    {
      key: 'mode',
      label: 'Mode',
      kind: 'select',
      required: true,
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    },
    {
      key: 'token',
      label: 'Token',
      kind: 'secret',
      required: false,
      requiredWhen: { key: 'mode', value: 'a' },
    },
  ],
  configurationVariants: {
    discriminator: 'mode',
    branches: [
      {
        id: 'ab',
        when: { properties: { mode: { enum: ['a', 'b'] } } },
        fields: ['token'],
      },
    ],
  },
} as unknown as PluginManifest;

const crossFieldManifest = {
  ...enumBranchManifest,
  pluginId: 'dev.clowder.fixture.cross-field',
  configuration: [
    {
      key: 'mode',
      label: 'Mode',
      kind: 'select',
      required: true,
      default: 'webhook',
      options: [
        { value: 'webhook', label: 'Webhook' },
        { value: 'websocket', label: 'Websocket' },
      ],
    },
    { key: 'enabled', label: 'Enabled', kind: 'boolean', required: true },
    {
      key: 'token',
      label: 'Token',
      kind: 'secret',
      required: false,
      requiredWhen: { key: 'enabled', value: true },
    },
  ],
  configurationVariants: {
    discriminator: 'mode',
    branches: [
      {
        id: 'webhook',
        when: { properties: { mode: { const: 'webhook' } } },
        fields: ['token'],
      },
      {
        id: 'websocket',
        when: { properties: { mode: { const: 'websocket' } } },
        fields: [],
      },
    ],
  },
} as unknown as PluginManifest;

function validates(manifest: PluginManifest, effectiveValues: Record<string, unknown>): boolean {
  const ajv = new AjvCtor();
  (addFormatsPkg as unknown as (instance: unknown) => void)(ajv);
  const validate = ajv.compile(buildVariantValidationSchema(manifest));
  return validate(effectiveValues) === true;
}

test('counterexample: enum branch covering a/b does not require the a-only token under b', () => {
  // Review-found case: an enum branch spanning several discriminator values
  // must not merge those values into a blanket "required" verdict.
  assert.equal(validates(enumBranchManifest, { mode: 'b' }), true);
  assert.equal(validates(enumBranchManifest, { mode: 'a' }), false);
  assert.equal(validates(enumBranchManifest, { mode: 'a', token: 'tok' }), true);
});

test('counterexample: null is rejected for a required secret', () => {
  assert.equal(validates(enumBranchManifest, { mode: 'a', token: null }), false);
  assert.equal(validates(enumBranchManifest, { mode: 'a', token: '' }), false);
});

test('counterexample: requiredWhen keyed on another field is enforced at validation time', () => {
  assert.equal(validates(crossFieldManifest, { mode: 'webhook', enabled: true }), false);
  assert.equal(validates(crossFieldManifest, { mode: 'webhook', enabled: true, token: 't' }), true);
  assert.equal(validates(crossFieldManifest, { mode: 'webhook', enabled: false }), true);
  assert.equal(
    validates(crossFieldManifest, { mode: 'websocket', enabled: true }),
    true,
  );
});

test('counterexample: required:true is overridden while the requiredWhen condition does not hold', () => {
  const manifest = structuredClone(crossFieldManifest) as PluginManifest;
  const token = manifest.configuration!.find((field) => field.key === 'token')!;
  (token as { required: boolean }).required = true;
  assert.equal(validates(manifest, { mode: 'webhook', enabled: false }), true);
  assert.equal(validates(manifest, { mode: 'webhook', enabled: true }), false);
});

test('coerceStoredValues converts string storage to declared scalar types', () => {
  assert.deepEqual(
    coerceStoredValues(crossFieldManifest, { enabled: 'true', retries: '3', mode: 'webhook' }),
    { enabled: true, retries: '3', mode: 'webhook' },
  );
  assert.deepEqual(coerceStoredValues(crossFieldManifest, { enabled: 'false' }), { enabled: false });
  // Unknown keys and non-string values pass through untouched.
  assert.deepEqual(coerceStoredValues(crossFieldManifest, { other: 'x', enabled: true }), {
    other: 'x',
    enabled: true,
  });
  // Garbage stays a string: downstream validation must fail closed, never silently coerce.
  assert.deepEqual(coerceStoredValues(crossFieldManifest, { enabled: 'yes' }), { enabled: 'yes' });
});

test('counterexample: string-stored boolean values satisfy the strict contract (review round three P1)', () => {
  // Host storage transports every scalar as a string. A legally-saved boolean
  // "true" must validate and must satisfy requiredWhen, not report incomplete.
  const stored = { mode: 'webhook', enabled: 'true', token: 't' };
  const { resolution, effectiveValues } = computeEffectiveConfiguration(crossFieldManifest, stored);
  assert.equal(resolution.status, 'selected');
  assert.equal(typeof effectiveValues.enabled, 'boolean');
  assert.equal(validates(crossFieldManifest, effectiveValues), true);
  const token = crossFieldManifest.configuration!.find((field) => field.key === 'token')!;
  assert.equal(evaluateFieldRequiredness(token, effectiveValues), true);
});

test('counterexample: string-stored boolean still fails closed for a missing conditional token', () => {
  const stored = { mode: 'webhook', enabled: 'true' };
  const { effectiveValues } = computeEffectiveConfiguration(crossFieldManifest, stored);
  assert.equal(validates(crossFieldManifest, effectiveValues), false);
});

for (const key of ['constructor', 'toString', 'hasOwnProperty']) {
  test(`variant values treat ${key} as an own configuration key`, () => {
    const manifest = {
      ...feishuLike,
      configuration: feishuLike.configuration!.map((field) =>
        field.key === 'connectionMode' ? { ...field, key } : field,
      ),
      configurationVariants: {
        ...feishuLike.configurationVariants!,
        discriminator: key,
        branches: feishuLike.configurationVariants!.branches.map((branch) => ({
          ...branch,
          when: { properties: { [key]: (branch.when['properties'] as Record<string, unknown>)['connectionMode'] } },
        })),
      },
    } as PluginManifest;
    assert.deepEqual(resolveConfigurationVariant(manifest, {}), {
      status: 'selected', branchId: 'webhook',
    });
    assert.equal(computeEffectiveConfiguration(manifest, {}).effectiveValues[key], 'webhook');
    assert.deepEqual(resolveConfigurationVariant(manifest, { [key]: 'websocket' }), {
      status: 'selected', branchId: 'websocket',
    });
    const noDefault = {
      ...manifest,
      configuration: manifest.configuration!.map((field) =>
        field.key === key ? { ...field, default: undefined } : field,
      ),
    } as PluginManifest;
    assert.deepEqual(resolveConfigurationVariant(noDefault, {}), { status: 'unselected' });

    const common = {
      ...feishuLike,
      configuration: [
        ...feishuLike.configuration!,
        { key, label: key, kind: 'string', default: 'fallback' },
      ],
    } as PluginManifest;
    assert.equal(computeEffectiveConfiguration(common, {}).effectiveValues[key], 'fallback');
    assert.equal(computeEffectiveConfiguration(common, { [key]: 'saved' }).effectiveValues[key], 'saved');
    const conditional = {
      key: 'token', label: 'Token', kind: 'secret',
      requiredWhen: { key, value: 'saved' },
    } as NonNullable<PluginManifest['configuration']>[number];
    assert.equal(evaluateFieldRequiredness(conditional, Object.create({ [key]: 'saved' })), false);
    assert.equal(evaluateFieldRequiredness(conditional, { [key]: 'saved' }), true);
  });
}

for (const branchOwned of [false, true]) {
  test(`duplicate requiredWhen values preserve semantics for ${branchOwned ? 'branch' : 'common'} fields`, () => {
    const manifest = {
      ...enumBranchManifest,
      configuration: enumBranchManifest.configuration!.map((field) =>
        field.key === 'token' ? { ...field, requiredWhen: { key: 'mode', value: ['a', 'a'] } } : field,
      ),
      ...(branchOwned ? {} : { configurationVariants: undefined }),
    } as PluginManifest;
    assert.equal(validates(manifest, { mode: 'a' }), false);
    assert.equal(validates(manifest, { mode: 'a', token: 'saved' }), true);
    assert.equal(validates(manifest, { mode: 'b' }), true);
  });

  test(`select options constrain ${branchOwned ? 'branch' : 'common'} fields`, () => {
    const manifest = {
      ...enumBranchManifest,
      configuration: [
        ...enumBranchManifest.configuration!,
        { key: 'provider', label: 'Provider', kind: 'select', required: false, options: [{ label: 'Valid', value: 'valid' }] },
      ],
      configurationVariants: {
        ...enumBranchManifest.configurationVariants!,
        branches: enumBranchManifest.configurationVariants!.branches.map((branch) => ({
          ...branch, fields: branchOwned ? [...branch.fields, 'provider'] : branch.fields,
        })),
      },
    } as PluginManifest;
    assert.equal(validates(manifest, { mode: 'b', provider: 'stale-provider' }), false);
    assert.equal(validates(manifest, { mode: 'b', provider: 'valid' }), true);
    assert.equal(validates(manifest, { mode: 'b' }), true);
  });
}

for (const placement of ['legacy', 'common', 'branch'] as const) {
  test(`operation controls do not become scalar values or requirements (${placement})`, () => {
    const manifest = {
      ...enumBranchManifest,
      configuration: [
        ...enumBranchManifest.configuration!,
        { key: 'login', label: 'Login', kind: 'operation', required: true, target: ['botToken'],
          actions: [{ id: 'login', label: 'Login', render: 'button', action: { method: 'login' } }] },
        { key: 'botToken', label: 'Bot token', kind: 'secret', required: true },
      ],
      configurationVariants: placement === 'legacy' ? undefined : {
        ...enumBranchManifest.configurationVariants!,
        branches: enumBranchManifest.configurationVariants!.branches.map((branch) => ({
          ...branch, fields: placement === 'branch' ? [...branch.fields, 'login', 'botToken'] : branch.fields,
        })),
      },
    } as PluginManifest;
    const complete = computeEffectiveConfiguration(manifest, { mode: 'b', botToken: 'saved', login: 'stale-control-value' });
    assert.equal(validates(manifest, { ...complete.effectiveValues, login: undefined }), true);
    assert.equal(Object.hasOwn(complete.effectiveValues, 'login'), false);
    assert.equal(validates(manifest, computeEffectiveConfiguration(manifest, { mode: 'b' }).effectiveValues), false);
  });
}

for (const branchOwned of [false, true]) {
  test(`URL fields enforce URI syntax (${branchOwned ? 'branch' : 'common'})`, () => {
    const manifest = {
      ...enumBranchManifest,
      configuration: [
        ...enumBranchManifest.configuration!,
        { key: 'baseUrl', label: 'Base URL', kind: 'url', required: false },
      ],
      configurationVariants: {
        ...enumBranchManifest.configurationVariants!,
        branches: enumBranchManifest.configurationVariants!.branches.map((branch) => ({
          ...branch, fields: branchOwned ? [...branch.fields, 'baseUrl'] : branch.fields,
        })),
      },
    } as PluginManifest;
    for (const baseUrl of ['not-a-url', '/relative/path', '', 'https://bad host.example']) {
      assert.equal(validates(manifest, { mode: 'b', baseUrl }), false, baseUrl);
    }
    assert.equal(validates(manifest, { mode: 'b', baseUrl: 'https://example.com/v1?key=value' }), true);
    assert.equal(validates(manifest, { mode: 'b' }), true);
  });
}

for (const kind of ['string', 'secret'] as const) {
  for (const branchOwned of [false, true]) {
    test(`configured ${kind} requires non-whitespace content (${branchOwned ? 'branch' : 'common'})`, () => {
      const manifest = {
        ...enumBranchManifest,
        configuration: [
          ...enumBranchManifest.configuration!,
          { key: 'credential', label: 'Credential', kind, required: true },
        ],
        configurationVariants: {
          ...enumBranchManifest.configurationVariants!,
          branches: enumBranchManifest.configurationVariants!.branches.map((branch) => ({
            ...branch, fields: branchOwned ? [...branch.fields, 'credential'] : branch.fields,
          })),
        },
      } as PluginManifest;
      for (const credential of [' ', '\t\r\n', '\u00a0', '\u3000']) {
        assert.equal(validates(manifest, { mode: 'b', credential }), false, JSON.stringify(credential));
      }
      const values = computeEffectiveConfiguration(manifest, { mode: 'b', credential: '  retained secret  ' }).effectiveValues;
      assert.equal(values['credential'], '  retained secret  ');
      assert.equal(validates(manifest, values), true);
    });
  }
}
