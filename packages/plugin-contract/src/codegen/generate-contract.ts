import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export interface JsonSchema {
  readonly $defs?: Record<string, JsonSchema>;
  readonly $ref?: string;
  readonly type?: string | readonly string[];
  readonly enum?: string[];
  readonly const?: unknown;
  readonly pattern?: string;
  readonly properties?: Record<string, JsonSchema>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly oneOf?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
  readonly allOf?: readonly JsonSchema[];
  readonly not?: JsonSchema;
  readonly additionalProperties?: boolean | JsonSchema;
  readonly [key: string]: unknown;
}

export interface ContractSchemas {
  readonly pluginMetadata: JsonSchema;
  readonly manifest: JsonSchema;
  readonly catalog: JsonSchema;
  readonly signals: JsonSchema;
  readonly messaging: JsonSchema;
  readonly physicalLimb: JsonSchema;
  readonly behavior: JsonSchema;
}

const GENERATED_URL = new URL('../generated/contract.generated.ts', import.meta.url);
const MANIFEST_CAPABILITY_REF =
  'https://clowder-ai.dev/schemas/manifest/v0.1#/$defs/Capability';
const PLUGIN_METADATA_SCHEMA_PREFIX =
  'https://clowder-ai.dev/schemas/plugin-metadata/v1#/$defs/';
const SIGNAL_SCHEMA_PREFIX = 'https://clowder-ai.dev/schemas/signals/v0.2#/$defs/';

async function readSchema(url: URL): Promise<JsonSchema> {
  return JSON.parse(await readFile(url, 'utf8')) as JsonSchema;
}

export async function loadContractSchemas(): Promise<ContractSchemas> {
  return {
    pluginMetadata: await readSchema(
      new URL('../schemas/plugin-metadata.schema.json', import.meta.url),
    ),
    manifest: await readSchema(new URL('../schemas/manifest.schema.json', import.meta.url)),
    catalog: await readSchema(new URL('../schemas/catalog.schema.json', import.meta.url)),
    signals: await readSchema(new URL('../schemas/signal.schema.json', import.meta.url)),
    messaging: await readSchema(new URL('../schemas/messaging.schema.json', import.meta.url)),
    physicalLimb: await readSchema(
      new URL('../schemas/physical-limb.schema.json', import.meta.url),
    ),
    behavior: await readSchema(
      new URL('../schemas/behavior-fixture.schema.json', import.meta.url),
    ),
  };
}

function quote(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function literal(value: unknown): string {
  if (typeof value === 'string') return quote(value);
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new Error(`Unsupported schema literal: ${JSON.stringify(value)}`);
}

function refName(ref: string): string {
  if (ref === MANIFEST_CAPABILITY_REF) return 'Capability';
  if (ref.startsWith(PLUGIN_METADATA_SCHEMA_PREFIX)) {
    return decodeURIComponent(ref.slice(PLUGIN_METADATA_SCHEMA_PREFIX.length));
  }
  if (ref.startsWith(SIGNAL_SCHEMA_PREFIX)) {
    return decodeURIComponent(ref.slice(SIGNAL_SCHEMA_PREFIX.length));
  }

  const marker = '#/$defs/';
  if (!ref.startsWith(marker)) {
    throw new Error(`Unsupported schema reference: ${ref}`);
  }
  return decodeURIComponent(ref.slice(marker.length));
}

function arrayType(schema: JsonSchema, itemType: string): string {
  const fixedLength = schema.minItems;
  if (
    typeof fixedLength === 'number' &&
    Number.isInteger(fixedLength) &&
    fixedLength === schema.maxItems &&
    fixedLength >= 0
  ) {
    return `readonly [${Array.from({ length: fixedLength }, () => itemType).join(', ')}]`;
  }
  const needsParentheses = itemType.includes(' | ') || itemType.includes('\n');
  return `readonly ${needsParentheses ? `(${itemType})` : itemType}[]`;
}

function propertyName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : quote(name);
}

function indentContinuation(value: string, spaces: number): string {
  const indent = ' '.repeat(spaces);
  return value.replaceAll('\n', `\n${indent}`);
}

function renderPropertyType(schema: JsonSchema): string {
  if (schema.$ref && schema.pattern) {
    const suffix = /^\\\.([A-Za-z0-9]+)\$$/u.exec(schema.pattern)?.[1];
    if (!suffix) {
      throw new Error(`Unsupported referenced string pattern: ${schema.pattern}`);
    }
    return `${renderType({ $ref: schema.$ref })} & \`\${string}.${suffix}\``;
  }
  return renderType(schema);
}

function renderObjectShape(
  properties: Readonly<Record<string, JsonSchema>>,
  required: ReadonlySet<string>,
  forbidden: ReadonlySet<string> = new Set(),
  renderedProperties: Readonly<Record<string, string>> = {},
): string {
  const entries = Object.entries(properties);

  if (entries.length === 0) {
    return 'Record<string, never>';
  }

  const fields = entries.map(([name, property]) => {
    if (forbidden.has(name)) {
      if (required.has(name)) {
        throw new Error(`Schema property ${name} cannot be both required and forbidden`);
      }
      return `  readonly ${propertyName(name)}?: never;`;
    }
    const optional = required.has(name) ? '' : '?';
    const rendered = indentContinuation(
      renderedProperties[name] ?? renderPropertyType(property),
      2,
    );
    return `  readonly ${propertyName(name)}${optional}: ${rendered};`;
  });
  return `{\n${fields.join('\n')}\n}`;
}

function renderObject(schema: JsonSchema): string {
  const properties = schema.properties ?? {};
  if (Object.keys(properties).length === 0) {
    if (schema.additionalProperties === false) return 'Record<string, never>';
    if (typeof schema.additionalProperties === 'object') {
      return `Readonly<Record<string, ${renderType(schema.additionalProperties)}>>`;
    }
    return 'Readonly<Record<string, unknown>>';
  }
  return renderObjectShape(properties, new Set(schema.required ?? []));
}

function renderDiscriminatedObject(schema: JsonSchema, discriminator: string): string {
  if (schema.type !== 'object') {
    throw new Error(`Discriminated schema must be an object: ${discriminator}`);
  }

  const baseProperties = schema.properties ?? {};
  const values = baseProperties[discriminator]?.enum;
  if (!values?.length) {
    throw new Error(`Discriminated schema must enumerate ${discriminator}`);
  }

  return values
    .map((value) => {
      const properties: Record<string, JsonSchema> = {
        ...baseProperties,
        [discriminator]: { const: value },
      };
      const required = new Set(schema.required ?? []);
      const forbidden = new Set<string>();

      for (const rule of schema.allOf ?? []) {
        const condition = rule['if'] as JsonSchema | undefined;
        if (!condition) {
          throw new Error(`Unsupported unconditional allOf rule for ${discriminator}`);
        }
        const discriminatorCondition = condition.properties?.[discriminator];
        if (!discriminatorCondition) {
          throw new Error(`Conditional rule must constrain ${discriminator}`);
        }
        const conditionMatches =
          discriminatorCondition.const === value ||
          discriminatorCondition.enum?.includes(value) === true;
        const branch = rule[conditionMatches ? 'then' : 'else'] as JsonSchema | undefined;
        if (!branch) continue;

        for (const name of branch.required ?? []) required.add(name);
        for (const name of branch.not?.required ?? []) forbidden.add(name);
        for (const [name, override] of Object.entries(
          (branch.properties ?? {}) as Record<string, JsonSchema | false>,
        )) {
          if (override === false) {
            forbidden.add(name);
            continue;
          }
          properties[name] = { ...properties[name], ...override };
        }
      }

      return renderObjectShape(properties, required, forbidden);
    })
    .join(' | ');
}

function schemaStringValues(schema: JsonSchema | undefined, label: string): readonly string[] {
  const values =
    schema?.enum ?? (typeof schema?.const === 'string' ? [schema.const] : undefined);
  if (!values?.length || !values.every((value) => typeof value === 'string')) {
    throw new Error(`${label} must be a non-empty string const or enum`);
  }
  return values;
}

function renderBehaviorExecutionConstraint(schema: JsonSchema): string {
  const planes = schemaStringValues(
    schema.properties?.['plane'],
    'BehaviorCase execution.plane',
  );
  const methodSchema = schema.properties?.['method'];
  const methods = methodSchema
    ? schemaStringValues(methodSchema, 'BehaviorCase execution.method')
    : [];

  return planes
    .flatMap((plane) => {
      const base = `Extract<BehaviorExecution, { readonly plane: ${quote(plane)} }>`;
      if (methods.length === 0) return [base];
      return methods.map(
        (method) => `${base} & { readonly method: ${quote(method)} }`,
      );
    })
    .join(' | ');
}

function renderBehaviorCase(schema: JsonSchema): string {
  if (schema.type !== 'object') {
    throw new Error('BehaviorCase must be an object');
  }
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);

  return (schema.allOf ?? [])
    .map((rule) => {
      const condition = rule['if'] as JsonSchema | undefined;
      const consequence = rule['then'] as JsonSchema | undefined;
      const operation = condition?.properties?.['when']?.properties?.['operation'];
      const execution = consequence?.properties?.['execution'];
      const operations = schemaStringValues(operation, 'BehaviorCase when.operation');
      if (!execution) {
        throw new Error('BehaviorCase conditional must constrain execution');
      }

      return renderObjectShape(properties, required, new Set(), {
        when: `Extract<FixtureOperation, { readonly operation: ${operations
          .map(quote)
          .join(' | ')} }>`,
        execution: renderBehaviorExecutionConstraint(execution),
      });
    })
    .join(' | ');
}

function renderType(schema: JsonSchema): string {
  if (schema.$ref) return refName(schema.$ref);
  if (schema.const !== undefined) return literal(schema.const);
  if (schema.enum) return schema.enum.map(quote).join(' | ');

  const alternatives = schema.oneOf ?? schema.anyOf;
  if (alternatives) return alternatives.map(renderType).join(' | ');

  if (Array.isArray(schema.type)) {
    return schema.type.map((type) => renderType({ ...schema, type })).join(' | ');
  }

  switch (schema.type) {
    case 'object':
      return renderObject(schema);
    case 'array':
      return arrayType(schema, renderType(schema.items ?? {}));
    case 'string':
      return 'string';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case undefined:
      return 'unknown';
    default:
      throw new Error(`Unsupported schema type: ${String(schema.type)}`);
  }
}

function renderDataDeclaration(schema: JsonSchema, definition: JsonSchema): string {
  const strategies = deriveDataClassStrategies(schema);
  const variants = Object.entries(strategies).map(([dataClass, allowedStrategies]) =>
    renderType({
      ...definition,
      properties: {
        ...definition.properties,
        dataClass: { const: dataClass },
        strategy: { enum: [...allowedStrategies] },
      },
    }),
  );
  return variants.join(' | ');
}

function renderDefinition(schema: JsonSchema, name: string, definition: JsonSchema): string {
  if (name === 'DataDeclaration' && schema['x-clowder-data-class-strategies'] !== undefined) {
    return renderDataDeclaration(schema, definition);
  }
  if (name === 'ConfigurationField') {
    return renderDiscriminatedObject(definition, 'kind');
  }
  if (name === 'PackageIcon') {
    return renderDiscriminatedObject(definition, 'type');
  }
  if (definition.allOf?.length) {
    throw new Error(`Unhandled conditional schema definition: ${name}`);
  }
  return renderType(definition);
}

function renderDefinitions(schema: JsonSchema): string[] {
  return Object.entries(schema.$defs ?? {}).map(
    ([name, definition]) => `export type ${name} = ${renderDefinition(schema, name, definition)};`,
  );
}

function renderBehaviorDefinitions(
  behavior: JsonSchema,
  manifest: JsonSchema,
  messaging: JsonSchema,
): string[] {
  const existingDefinitions = new Map<string, { owner: string; schema: JsonSchema }>([
    ...Object.entries(manifest.$defs ?? {}).map(
      ([name, schema]) => [name, { owner: 'manifest', schema }] as const,
    ),
    ...Object.entries(messaging.$defs ?? {}).map(
      ([name, schema]) => [name, { owner: 'messaging', schema }] as const,
    ),
  ]);

  return Object.entries(behavior.$defs ?? {}).flatMap(([name, definition]) => {
    const existing = existingDefinitions.get(name);
    if (!existing) {
      let rendered: string;
      if (name === 'SideEffectAssertion') {
        rendered = renderDiscriminatedObject(definition, 'assertion');
      } else if (name === 'ExpectedVerdict') {
        rendered = renderDiscriminatedObject(definition, 'status');
      } else if (name === 'BehaviorCase') {
        rendered = renderBehaviorCase(definition);
      } else if (definition.allOf?.length) {
        throw new Error(`Unhandled conditional behavior definition: ${name}`);
      } else {
        rendered = renderType(definition);
      }
      return [`export type ${name} = ${rendered};`];
    }
    if (!isDeepStrictEqual(definition, existing.schema)) {
      throw new Error(
        `behavior ${name} must match the ${existing.owner} schema definition`,
      );
    }
    return [];
  });
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
}

function stringArrayMap(value: unknown, label: string): Record<string, readonly string[]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, stringArray(item, `${label}.${key}`)]),
  );
}

function numberMap(value: unknown, label: string): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const entries = Object.entries(value);
  if (!entries.every(([, item]) => typeof item === 'number')) {
    throw new Error(`${label} values must be numbers`);
  }
  return Object.fromEntries(entries) as Record<string, number>;
}

function renderConstArray(name: string, values: readonly string[]): string {
  return `export const ${name} = [${values.map(quote).join(', ')}] as const;`;
}

function renderCapabilityTables(schema: JsonSchema): string[] {
  const layers = stringArrayMap(
    schema['x-clowder-capability-layers'],
    'x-clowder-capability-layers',
  );
  const capabilityValues = schema.$defs?.['Capability']?.enum ?? [];
  const layeredValues = Object.values(layers).flat();
  if (
    capabilityValues.length !== layeredValues.length ||
    capabilityValues.some((value) => !layeredValues.includes(value))
  ) {
    throw new Error('Capability enum and capability layer metadata must contain identical values');
  }

  const lines: string[] = [];
  for (const [layer, values] of Object.entries(layers)) {
    lines.push(renderConstArray(`${layer}_CAPABILITIES`, values));
    lines.push(`export type ${layer}Capability = (typeof ${layer}_CAPABILITIES)[number];`);
  }
  lines.push('export const CAPABILITY_TABLE = {');
  for (const layer of Object.keys(layers)) {
    lines.push(`  ${layer}: ${layer}_CAPABILITIES,`);
  }
  lines.push('} as const;');
  lines.push('export type AuthorizationLayer = keyof typeof CAPABILITY_TABLE;');
  return lines;
}

function renderDataStrategyTable(schema: JsonSchema): string[] {
  const strategies = stringArrayMap(
    schema['x-clowder-data-class-strategies'],
    'x-clowder-data-class-strategies',
  );
  const lines = ['export const DATA_CLASS_ALLOWED_STRATEGIES = {'];
  for (const [dataClass, values] of Object.entries(strategies)) {
    lines.push(`  ${quote(dataClass)}: [${values.map(quote).join(', ')}],`);
  }
  lines.push(
    '} as const satisfies Readonly<Record<DataClass, readonly DataStrategy[]>>;',
  );
  return lines;
}

function renderMessagingBounds(schema: JsonSchema): string[] {
  const bounds = numberMap(schema['x-clowder-bounds'], 'x-clowder-bounds');
  const lines = ['export const MESSAGING_BOUNDS = {'];
  for (const [name, value] of Object.entries(bounds)) {
    lines.push(`  ${name}: ${value},`);
  }
  lines.push('} as const;');
  return lines;
}

function renderMessagingReplayWindowDefault(schema: JsonSchema): string[] {
  const replayWindow = schema['x-clowder-replay-window-default'];
  if (typeof replayWindow !== 'string' || !/^P[1-9][0-9]*D$/.test(replayWindow)) {
    throw new Error('messaging replay window default must use ISO 8601 days (for example P7D)');
  }
  return [
    '/**',
    ' * @signed(G-0 2026-07-15)',
    ' * Host control plane/UI obligation: expose effective retention to users.',
    ' * This does not add a plugin handshake field or query API.',
    ' */',
    `export const MESSAGING_REPLAY_WINDOW_DEFAULT = ${quote(replayWindow)} as const;`,
  ];
}

function schemaProperty(
  schema: JsonSchema,
  definitionName: string,
  property: string,
): JsonSchema {
  const result = schema.$defs?.[definitionName]?.properties?.[property];
  if (!result) throw new Error(`Missing schema property ${definitionName}.${property}`);
  return result;
}

function assertSchemaNumber(
  schema: JsonSchema,
  metadataName: string,
  expected: number,
  definitionName: string,
  property: string,
  keyword: string,
): void {
  const actual = schemaProperty(schema, definitionName, property)[keyword];
  if (actual !== expected) {
    throw new Error(
      `${metadataName} metadata (${expected}) must match ${definitionName}.${property}.${keyword} (${String(actual)})`,
    );
  }
}

function validateMessagingBounds(schema: JsonSchema): void {
  const bounds = numberMap(schema['x-clowder-bounds'], 'x-clowder-bounds');
  for (const definitionName of [
    'DraftPayload',
    'AppendElementsRequest',
    'MessageElementsAppendEvent',
  ]) {
    assertSchemaNumber(
      schema,
      'maxElementsPerOperation',
      bounds['maxElementsPerOperation']!,
      definitionName,
      'elements',
      'maxItems',
    );
  }
  assertSchemaNumber(
    schema,
    'maxElementsPerMessage',
    bounds['maxElementsPerMessage']!,
    'MessagePayload',
    'elements',
    'maxItems',
  );
  assertSchemaNumber(
    schema,
    'maxWhisperTargets',
    bounds['maxWhisperTargets']!,
    'WhisperAudience',
    'targets',
    'maxItems',
  );
  for (const [definitionName, property] of [
    ['MessageDraft', 'idempotencyKey'],
    ['AppendElementsRequest', 'operationId'],
    ['MessageElementsAppendEvent', 'operationId'],
  ] as const) {
    assertSchemaNumber(
      schema,
      'maxIdempotencyKeyLength',
      bounds['maxIdempotencyKeyLength']!,
      definitionName,
      property,
      'maxLength',
    );
  }
  for (const definitionName of [
    'TextMessageElement',
    'MediaRefMessageElement',
    'RichBlockMessageElement',
  ]) {
    for (const property of ['elementId', 'derivedFromElementId']) {
      assertSchemaNumber(
        schema,
        'maxElementIdLength',
        bounds['maxElementIdLength']!,
        definitionName,
        property,
        'maxLength',
      );
    }
  }
}

function deriveDataClassStrategies(schema: JsonSchema): Record<string, readonly string[]> {
  const dataClasses = schema.$defs?.['DataClass']?.enum ?? [];
  const allStrategies = schema.$defs?.['DataStrategy']?.enum ?? [];
  const declaration = schema.$defs?.['DataDeclaration'];
  const rules = declaration?.allOf ?? [];
  const result: Record<string, readonly string[]> = {};

  for (const dataClass of dataClasses) {
    let allowed = [...allStrategies];
    for (const rule of rules) {
      const condition = rule['if'] as JsonSchema | undefined;
      const consequence = rule['then'] as JsonSchema | undefined;
      const restrictedClasses = condition?.properties?.['dataClass']?.enum ?? [];
      if (!restrictedClasses.includes(dataClass)) continue;
      const restrictedStrategies = consequence?.properties?.['strategy']?.enum;
      if (restrictedStrategies) {
        allowed = allowed.filter((strategy) => restrictedStrategies.includes(strategy));
      }
    }
    result[dataClass] = allowed;
  }
  return result;
}

function validateDataStrategyMetadata(schema: JsonSchema): void {
  const metadata = stringArrayMap(
    schema['x-clowder-data-class-strategies'],
    'x-clowder-data-class-strategies',
  );
  const derived = deriveDataClassStrategies(schema);
  const keys = new Set([...Object.keys(metadata), ...Object.keys(derived)]);

  for (const dataClass of keys) {
    const declared = metadata[dataClass] ?? [];
    const expected = derived[dataClass] ?? [];
    if (
      declared.length !== expected.length ||
      declared.some((strategy) => !expected.includes(strategy))
    ) {
      throw new Error(
        `data-class strategy metadata for ${dataClass} must match schema constraints`,
      );
    }
  }
}

export function generateContractSource(schemas: ContractSchemas): string {
  validateDataStrategyMetadata(schemas.manifest);
  validateMessagingBounds(schemas.messaging);
  const sections = [
    '/**',
    ' * Generated from plugin-metadata.schema.json, manifest.schema.json, catalog.schema.json, signal.schema.json, messaging.schema.json, physical-limb.schema.json, and behavior-fixture.schema.json.',
    ' * Do not edit by hand. Run `pnpm generate` after changing a schema.',
    ' */',
    '',
    ...renderDefinitions(schemas.pluginMetadata),
    '',
    ...renderDefinitions(schemas.manifest),
    '',
    `export type PluginManifest = ${renderType(schemas.manifest)};`,
    '',
    ...renderDefinitions(schemas.catalog),
    '',
    `export type PluginCatalog = ${renderType(schemas.catalog)};`,
    '',
    ...renderDefinitions(schemas.signals),
    '',
    ...renderDefinitions(schemas.messaging),
    '',
    ...renderDefinitions(schemas.physicalLimb),
    '',
    ...renderBehaviorDefinitions(schemas.behavior, schemas.manifest, schemas.messaging),
    '',
    `export type BehaviorFixture = ${renderType(schemas.behavior)};`,
    '',
    ...renderCapabilityTables(schemas.manifest),
    '',
    ...renderDataStrategyTable(schemas.manifest),
    '',
    ...renderMessagingBounds(schemas.messaging),
    '',
    ...renderMessagingReplayWindowDefault(schemas.messaging),
    '',
  ];
  return `${sections.join('\n').trimEnd()}\n`;
}

export async function writeGeneratedContract(): Promise<void> {
  const source = generateContractSource(await loadContractSchemas());
  await mkdir(dirname(fileURLToPath(GENERATED_URL)), { recursive: true });
  await writeFile(GENERATED_URL, source, 'utf8');
}

export async function checkGeneratedContract(): Promise<boolean> {
  const expected = generateContractSource(await loadContractSchemas());
  let actual: string;
  try {
    actual = await readFile(GENERATED_URL, 'utf8');
  } catch {
    return false;
  }
  return actual === expected;
}

async function main(): Promise<void> {
  if (process.argv.includes('--check')) {
    if (!(await checkGeneratedContract())) {
      console.error('Generated contract is stale. Run `pnpm --filter @clowder-ai/plugin-contract generate`.');
      process.exitCode = 1;
      return;
    }
    console.log('✅ Generated contract is current');
    return;
  }

  await writeGeneratedContract();
  console.log(`Generated ${fileURLToPath(GENERATED_URL)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
