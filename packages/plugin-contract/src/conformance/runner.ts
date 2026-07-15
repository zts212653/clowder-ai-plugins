/**
 * Conformance runner skeleton.
 *
 * Validates fixture files against contract JSON Schemas.  This is the
 * mechanical verification that fixtures (maintained by sol) conform to
 * the schema shapes (maintained by opus).
 *
 * Usage:
 *   pnpm --filter @clowder-ai/plugin-contract conformance
 *
 * Exit codes:
 *   0 = all fixtures valid (or no fixtures yet)
 *   1 = validation errors found
 *
 * @packageDocumentation
 */

import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Ajv is CJS — use createRequire for clean interop with ESM + verbatimModuleSyntax
// Use ajv/dist/2020 for JSON Schema 2020-12 ($defs, etc.)
const require = createRequire(import.meta.url);
const Ajv: new (opts: { allErrors: boolean; strict: boolean }) => AjvInstance = require('ajv/dist/2020');
const addFormats: (ajv: AjvInstance) => void = require('ajv-formats');

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PKG_ROOT = join(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Ajv minimal type surface (avoids CJS/ESM interop headaches)
// ---------------------------------------------------------------------------

interface AjvErrorObject {
  instancePath: string;
  message?: string;
}

interface AjvValidateFn {
  (data: unknown): boolean;
  errors?: AjvErrorObject[] | null;
}

interface AjvInstance {
  addSchema(schema: Record<string, unknown>, id: string): void;
  getSchema(ref: string): AjvValidateFn | undefined;
}

// ---------------------------------------------------------------------------
// Schema loading
// ---------------------------------------------------------------------------

async function loadSchema(schemaPath: string): Promise<Record<string, unknown>> {
  const raw = await readFile(schemaPath, 'utf-8');
  return JSON.parse(raw) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Fixture discovery
// ---------------------------------------------------------------------------

interface FixtureFile {
  path: string;
  relativePath: string;
  domain: string;
  validity: 'valid' | 'invalid';
}

async function discoverFixtures(fixturesDir: string): Promise<FixtureFile[]> {
  const fixtures: FixtureFile[] = [];
  const domains = ['manifest', 'messaging'];

  for (const domain of domains) {
    for (const validity of ['valid', 'invalid'] as const) {
      const dir = join(fixturesDir, domain, validity);
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        // Directory may not exist yet — sol adds fixtures incrementally
        continue;
      }

      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        fixtures.push({
          path: join(dir, entry),
          relativePath: relative(fixturesDir, join(dir, entry)),
          domain,
          validity,
        });
      }
    }
  }

  return fixtures;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface ValidationResult {
  fixture: FixtureFile;
  passed: boolean;
  errors?: string[];
}

function getDefaultSchemaId(domain: string): string {
  const ids: Record<string, string> = {
    manifest: 'https://clowder-ai.dev/schemas/manifest/v0.1',
    messaging: 'https://clowder-ai.dev/schemas/messaging/v0.1',
  };
  return ids[domain] ?? '';
}

async function validateFixture(
  ajv: AjvInstance,
  fixture: FixtureFile,
  schemas: Map<string, Record<string, unknown>>,
): Promise<ValidationResult> {
  const schema = schemas.get(fixture.domain);
  if (!schema) {
    return {
      fixture,
      passed: false,
      errors: [`No schema found for domain: ${fixture.domain}`],
    };
  }

  const raw = await readFile(fixture.path, 'utf-8');
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e: unknown) {
    return {
      fixture,
      passed: false,
      errors: [`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`],
    };
  }

  // Fixture files may specify which $def they target via a _meta field
  const meta = (data as Record<string, unknown>)?.['_meta'] as
    | { schemaRef?: string }
    | undefined;

  const schemaId = getDefaultSchemaId(fixture.domain);
  const ref = meta?.schemaRef
    ? `${schemaId}#/$defs/${meta.schemaRef}`
    : schemaId;

  // Strip _meta before validation (it's runner metadata, not contract data)
  if (meta) {
    delete (data as Record<string, unknown>)['_meta'];
  }

  const validate = ajv.getSchema(ref);
  if (!validate) {
    return {
      fixture,
      passed: false,
      errors: [`Schema ref not found: ${ref}`],
    };
  }

  const isSchemaValid = validate(data);

  if (fixture.validity === 'valid') {
    // Valid fixtures MUST pass schema validation
    return {
      fixture,
      passed: isSchemaValid === true,
      errors: isSchemaValid
        ? undefined
        : validate.errors?.map((e) => `${e.instancePath}: ${e.message}`) ?? ['Unknown validation error'],
    };
  } else {
    // Invalid fixtures MUST fail schema validation (negative test)
    return {
      fixture,
      passed: isSchemaValid === false,
      errors: isSchemaValid
        ? ['Expected validation to FAIL for invalid fixture, but it passed']
        : undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const fixturesDir = join(PKG_ROOT, 'fixtures');
  const schemasDir = join(PKG_ROOT, 'src', 'schemas');

  console.log('🔍 Conformance runner — @clowder-ai/plugin-contract');
  console.log(`   Fixtures: ${fixturesDir}`);
  console.log(`   Schemas:  ${schemasDir}`);
  console.log();

  // Load schemas
  const schemas = new Map<string, Record<string, unknown>>();
  const manifestSchema = await loadSchema(join(schemasDir, 'manifest.schema.json'));
  const messagingSchema = await loadSchema(join(schemasDir, 'messaging.schema.json'));
  schemas.set('manifest', manifestSchema);
  schemas.set('messaging', messagingSchema);

  // Set up Ajv with format validation (date-time, uri, email, etc.)
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(manifestSchema, manifestSchema['$id'] as string);
  ajv.addSchema(messagingSchema, messagingSchema['$id'] as string);

  // Discover and validate fixtures
  const fixtures = await discoverFixtures(fixturesDir);

  if (fixtures.length === 0) {
    console.log('📭 No fixtures found — runner OK (empty run).');
    console.log('   Fixtures will be added by sol per the three-tier fixture plan.');
    process.exit(0);
  }

  const results: ValidationResult[] = [];
  for (const fixture of fixtures) {
    results.push(await validateFixture(ajv, fixture, schemas));
  }

  // Report
  let failures = 0;
  for (const result of results) {
    const icon = result.passed ? '✅' : '❌';
    const expect = result.fixture.validity === 'valid' ? 'should pass' : 'should fail';
    console.log(`${icon} ${result.fixture.relativePath} (${expect})`);
    if (result.errors) {
      for (const err of result.errors) {
        console.log(`   → ${err}`);
      }
      failures++;
    }
  }

  console.log();
  console.log(`Results: ${results.length - failures}/${results.length} passed`);

  if (failures > 0) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('Conformance runner crashed:', err);
  process.exit(1);
});
