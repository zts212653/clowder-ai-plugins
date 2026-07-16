import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export interface JsonSchema {
  readonly $defs?: Record<string, JsonSchema>;
  readonly $ref?: string;
  readonly type?: string | readonly string[];
  readonly enum?: string[];
  readonly const?: unknown;
  readonly properties?: Record<string, JsonSchema>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly oneOf?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
  readonly allOf?: readonly JsonSchema[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly [key: string]: unknown;
}

export interface ContractSchemas {
  readonly manifest: JsonSchema;
  readonly messaging: JsonSchema;
}

const GENERATED_URL = new URL('../generated/contract.generated.ts', import.meta.url);

async function readSchema(url: URL): Promise<JsonSchema> {
  return JSON.parse(await readFile(url, 'utf8')) as JsonSchema;
}

export async function loadContractSchemas(): Promise<ContractSchemas> {
  return {
    manifest: await readSchema(new URL('../schemas/manifest.schema.json', import.meta.url)),
    messaging: await readSchema(new URL('../schemas/messaging.schema.json', import.meta.url)),
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
  const marker = '#/$defs/';
  if (!ref.startsWith(marker)) {
    throw new Error(`Only local $defs references are supported: ${ref}`);
  }
  return decodeURIComponent(ref.slice(marker.length));
}

function arrayType(itemType: string): string {
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

function renderObject(schema: JsonSchema): string {
  const properties = schema.properties ?? {};
  const entries = Object.entries(properties);

  if (entries.length === 0) {
    if (schema.additionalProperties === false) return 'Record<string, never>';
    if (typeof schema.additionalProperties === 'object') {
      return `Readonly<Record<string, ${renderType(schema.additionalProperties)}>>`;
    }
    return 'Readonly<Record<string, unknown>>';
  }

  const required = new Set(schema.required ?? []);
  const fields = entries.map(([name, property]) => {
    const optional = required.has(name) ? '' : '?';
    const rendered = indentContinuation(renderType(property), 2);
    return `  readonly ${propertyName(name)}${optional}: ${rendered};`;
  });
  return `{\n${fields.join('\n')}\n}`;
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
      return arrayType(renderType(schema.items ?? {}));
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

function renderDefinitions(schema: JsonSchema): string[] {
  return Object.entries(schema.$defs ?? {}).map(([name, definition]) => {
    const rendered =
      name === 'DataDeclaration' && schema['x-clowder-data-class-strategies'] !== undefined
        ? renderDataDeclaration(schema, definition)
        : renderType(definition);
    return `export type ${name} = ${rendered};`;
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
    ' * Generated from manifest.schema.json and messaging.schema.json.',
    ' * Do not edit by hand. Run `pnpm generate` after changing a schema.',
    ' */',
    '',
    ...renderDefinitions(schemas.manifest),
    '',
    `export type PluginManifest = ${renderType(schemas.manifest)};`,
    '',
    ...renderDefinitions(schemas.messaging),
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
