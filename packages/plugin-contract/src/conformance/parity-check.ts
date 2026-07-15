/**
 * P15 Structural Parity Gate — JSON Schema <-> TypeScript alignment.
 *
 * The JSON Schema files are the canonical truth source (P15).
 * The TypeScript types are the developer-facing projection.
 * This script verifies they stay aligned.
 *
 * Checks:
 *   1. Schema $defs vs TS exported type names (coverage)
 *   2. Schema enum values vs TS union/const values (value parity)
 *   3. Manifest capability enum vs capability.ts L0/L1/L2 arrays
 *
 * NOT a full structural equivalence checker — catches the most common
 * drift modes (missing types, enum value mismatches). Expand as the
 * contract evolves.
 *
 * Usage:
 *   pnpm --filter @clowder-ai/plugin-contract parity
 *
 * @packageDocumentation
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PKG_ROOT = join(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

interface SchemaFile {
  $defs?: Record<string, SchemaDef>;
}

interface SchemaDef {
  type?: string;
  enum?: string[];
  properties?: Record<string, unknown>;
  required?: string[];
}

async function loadJson<T>(path: string): Promise<T> {
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw) as T;
}

function getSchemaEnumValues(schema: SchemaFile, defName: string): string[] | null {
  const def = schema.$defs?.[defName];
  if (!def?.enum) return null;
  return [...def.enum].sort();
}

// ---------------------------------------------------------------------------
// TS extraction helpers (targeted string parsing — not full AST)
// ---------------------------------------------------------------------------

/**
 * Extract union literal values from a TypeScript union type definition.
 * Matches:  export type Foo = 'a' | 'b' | 'c';
 *           export type Foo =\n  | 'a'\n  | 'b';
 */
function extractTsUnionValues(source: string, typeName: string): string[] | null {
  // Match: export type TypeName = ... ;
  const pattern = new RegExp(
    `export\\s+type\\s+${typeName}\\s*=\\s*([^;]+);`,
    's',
  );
  const match = pattern.exec(source);
  if (!match) return null;

  const body = match[1]!;
  const values: string[] = [];
  // Extract 'string-literal' values from the union
  const literalPattern = /'([^']+)'/g;
  let literalMatch: RegExpExecArray | null;
  while ((literalMatch = literalPattern.exec(body)) !== null) {
    values.push(literalMatch[1]!);
  }
  return values.length > 0 ? values.sort() : null;
}

/**
 * Extract values from a TypeScript `as const` array.
 * Matches:  export const FOO = ['a', 'b', 'c'] as const;
 *           export const FOO = [\n  'a',\n  'b',\n] as const;
 */
function extractTsConstArrayValues(source: string, constName: string): string[] | null {
  const pattern = new RegExp(
    `export\\s+const\\s+${constName}\\s*=\\s*\\[([^\\]]+)\\]\\s*as\\s+const`,
    's',
  );
  const match = pattern.exec(source);
  if (!match) return null;

  const body = match[1]!;
  const values: string[] = [];
  const literalPattern = /'([^']+)'/g;
  let literalMatch: RegExpExecArray | null;
  while ((literalMatch = literalPattern.exec(body)) !== null) {
    values.push(literalMatch[1]!);
  }
  return values.length > 0 ? values.sort() : null;
}

/**
 * Extract all exported type and interface names from a TS file.
 */
function extractExportedTypeNames(source: string): Set<string> {
  const names = new Set<string>();

  // export type Name = ...
  const typePattern = /export\s+type\s+(\w+)\s*=/g;
  let match: RegExpExecArray | null;
  while ((match = typePattern.exec(source)) !== null) {
    names.add(match[1]!);
  }

  // export interface Name { ... }
  const ifacePattern = /export\s+interface\s+(\w+)\s*\{/g;
  while ((match = ifacePattern.exec(source)) !== null) {
    names.add(match[1]!);
  }

  return names;
}

// ---------------------------------------------------------------------------
// Parity checks
// ---------------------------------------------------------------------------

interface ParityViolation {
  check: string;
  detail: string;
}

/**
 * Check that every schema $def name has a corresponding TS exported type.
 */
function checkDefCoverage(
  schemaName: string,
  schemaDefs: string[],
  tsNames: Set<string>,
  /** Some schema $defs don't map to top-level TS types (they're inlined). */
  exemptions: Set<string>,
): ParityViolation[] {
  const violations: ParityViolation[] = [];
  for (const defName of schemaDefs) {
    if (exemptions.has(defName)) continue;
    if (!tsNames.has(defName)) {
      violations.push({
        check: `${schemaName}.$defs coverage`,
        detail: `Schema $def '${defName}' has no matching TS export`,
      });
    }
  }
  return violations;
}

/**
 * Check that schema enum values exactly match TS union/const values.
 */
function checkEnumParity(
  label: string,
  schemaValues: string[] | null,
  tsValues: string[] | null,
): ParityViolation[] {
  const violations: ParityViolation[] = [];

  if (schemaValues === null && tsValues === null) return violations;
  if (schemaValues === null) {
    violations.push({ check: label, detail: 'Schema has no enum but TS has values' });
    return violations;
  }
  if (tsValues === null) {
    violations.push({ check: label, detail: 'TS has no values but schema has enum' });
    return violations;
  }

  const schemaSet = new Set(schemaValues);
  const tsSet = new Set(tsValues);

  for (const v of schemaValues) {
    if (!tsSet.has(v)) {
      violations.push({ check: label, detail: `Schema enum '${v}' missing from TS` });
    }
  }
  for (const v of tsValues) {
    if (!schemaSet.has(v)) {
      violations.push({ check: label, detail: `TS value '${v}' missing from schema enum` });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('🔗 P15 Parity Gate — @clowder-ai/plugin-contract');
  console.log();

  const schemasDir = join(PKG_ROOT, 'src', 'schemas');
  const typesDir = join(PKG_ROOT, 'src', 'types');

  // Load schemas
  const manifestSchema = await loadJson<SchemaFile>(join(schemasDir, 'manifest.schema.json'));
  const messagingSchema = await loadJson<SchemaFile>(join(schemasDir, 'messaging.schema.json'));

  // Load TS sources
  const commonTs = await readFile(join(typesDir, 'common.ts'), 'utf-8');
  const messagingTs = await readFile(join(typesDir, 'messaging.ts'), 'utf-8');
  const manifestTs = await readFile(join(typesDir, 'manifest.ts'), 'utf-8');
  const dataClassTs = await readFile(join(typesDir, 'data-class.ts'), 'utf-8');
  const capabilityTs = await readFile(join(typesDir, 'capability.ts'), 'utf-8');

  const violations: ParityViolation[] = [];

  // ── 1. $defs coverage ──────────────────────────────────────────────────

  // Messaging schema $defs → messaging.ts + common.ts
  const messagingDefs = Object.keys(messagingSchema.$defs ?? {});
  const messagingTsNames = new Set([
    ...extractExportedTypeNames(messagingTs),
    ...extractExportedTypeNames(commonTs),
  ]);
  // WhisperTargets is inlined into DraftAudience in TS (not a standalone type)
  const messagingExemptions = new Set(['WhisperTargets']);
  violations.push(
    ...checkDefCoverage('messaging', messagingDefs, messagingTsNames, messagingExemptions),
  );

  // Manifest schema $defs → manifest.ts + data-class.ts + capability.ts
  const manifestDefs = Object.keys(manifestSchema.$defs ?? {});
  const manifestTsNames = new Set([
    ...extractExportedTypeNames(manifestTs),
    ...extractExportedTypeNames(dataClassTs),
    ...extractExportedTypeNames(capabilityTs),
  ]);
  const manifestExemptions = new Set<string>();
  violations.push(
    ...checkDefCoverage('manifest', manifestDefs, manifestTsNames, manifestExemptions),
  );

  // ── 2. Enum value parity ───────────────────────────────────────────────

  // Messaging domain enums
  violations.push(...checkEnumParity(
    'ActorKind',
    getSchemaEnumValues(messagingSchema, 'ActorKind'),
    extractTsUnionValues(commonTs, 'ActorKind'),
  ));

  violations.push(...checkEnumParity(
    'EpistemicStatus',
    getSchemaEnumValues(messagingSchema, 'EpistemicStatus'),
    extractTsUnionValues(commonTs, 'EpistemicStatus'),
  ));

  violations.push(...checkEnumParity(
    'ElementKind',
    getSchemaEnumValues(messagingSchema, 'ElementKind'),
    extractTsUnionValues(messagingTs, 'ElementKind'),
  ));

  violations.push(...checkEnumParity(
    'MessagingErrorCode',
    getSchemaEnumValues(messagingSchema, 'MessagingErrorCode'),
    extractTsUnionValues(messagingTs, 'MessagingErrorCode'),
  ));

  // Manifest domain enums
  violations.push(...checkEnumParity(
    'DataClass',
    getSchemaEnumValues(manifestSchema, 'DataClass'),
    extractTsUnionValues(dataClassTs, 'DataClass'),
  ));

  violations.push(...checkEnumParity(
    'DataStrategy',
    getSchemaEnumValues(manifestSchema, 'DataStrategy'),
    extractTsUnionValues(dataClassTs, 'DataStrategy'),
  ));

  violations.push(...checkEnumParity(
    'RuntimeTransport',
    getSchemaEnumValues(manifestSchema, 'RuntimeTransport'),
    extractTsUnionValues(manifestTs, 'RuntimeTransport'),
  ));

  // ── 3. Capability parity (special: schema enum vs TS L0+L1+L2) ────────

  // Extract manifest schema capability enum from PluginFeature.capabilities.items.enum
  const featureDef = manifestSchema.$defs?.['PluginFeature'] as
    | { properties?: { capabilities?: { items?: { enum?: string[] } } } }
    | undefined;
  const schemaCapabilities = featureDef?.properties?.capabilities?.items?.enum
    ? [...featureDef.properties.capabilities.items.enum].sort()
    : null;

  // Extract TS capabilities from L0/L1/L2 const arrays
  const tsL0 = extractTsConstArrayValues(capabilityTs, 'L0_CAPABILITIES') ?? [];
  const tsL1 = extractTsConstArrayValues(capabilityTs, 'L1_CAPABILITIES') ?? [];
  const tsL2 = extractTsConstArrayValues(capabilityTs, 'L2_CAPABILITIES') ?? [];
  const tsCapabilities = [...tsL0, ...tsL1, ...tsL2].sort();

  violations.push(...checkEnumParity(
    'Capabilities (manifest schema vs capability.ts L0+L1+L2)',
    schemaCapabilities,
    tsCapabilities.length > 0 ? tsCapabilities : null,
  ));

  // ── Report ─────────────────────────────────────────────────────────────

  if (violations.length === 0) {
    console.log('✅ All parity checks passed');
    console.log();
    console.log('Checks run:');
    console.log('  - messaging schema $defs → TS type coverage');
    console.log('  - manifest schema $defs → TS type coverage');
    console.log('  - 7 enum/union parity checks');
    console.log('  - Capability table parity (schema enum vs L0+L1+L2)');
  } else {
    console.log(`❌ ${violations.length} P15 parity violation(s):`);
    console.log();
    for (const v of violations) {
      console.log(`  [${v.check}] ${v.detail}`);
    }
    console.log();
    console.log('Schema is the truth source — update TS types to match.');
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('Parity check crashed:', err);
  process.exit(1);
});
