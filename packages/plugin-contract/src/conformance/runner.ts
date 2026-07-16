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

import { validateMessagingSemantics } from '../validation/messaging-semantic.js';

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
  const semanticResult =
    fixture.domain === 'messaging' && isSchemaValid
      ? validateMessagingSemantics(meta?.schemaRef ?? 'root', data)
      : { valid: true, errors: [] };
  const isValid = isSchemaValid && semanticResult.valid;

  if (fixture.validity === 'valid') {
    // Valid fixtures MUST pass structural and semantic validation.
    return {
      fixture,
      passed: isValid,
      errors: isValid
        ? undefined
        : [
            ...(validate.errors?.map((e) => `${e.instancePath}: ${e.message}`) ?? []),
            ...semanticResult.errors.map((e) => `${e.path}: ${e.message}`),
          ],
    };
  } else {
    // Invalid fixtures may fail either structural or semantic validation.
    return {
      fixture,
      passed: isValid === false,
      errors: isValid
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
  const behaviorSchema = await loadSchema(join(schemasDir, 'behavior-fixture.schema.json'));
  schemas.set('manifest', manifestSchema);
  schemas.set('messaging', messagingSchema);

  // Set up Ajv with format validation (date-time, uri, email, etc.)
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(manifestSchema, manifestSchema['$id'] as string);
  ajv.addSchema(messagingSchema, messagingSchema['$id'] as string);
  ajv.addSchema(behaviorSchema, behaviorSchema['$id'] as string);

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

  // Report schema fixtures
  let schemaFailures = 0;
  for (const result of results) {
    const icon = result.passed ? '✅' : '❌';
    const expect = result.fixture.validity === 'valid' ? 'should pass' : 'should fail';
    console.log(`${icon} ${result.fixture.relativePath} (${expect})`);
    if (result.errors) {
      for (const err of result.errors) {
        console.log(`   → ${err}`);
      }
      schemaFailures++;
    }
  }

  // Validate and report behavioral fixtures before deferring their execution.
  const behaviorDir = join(fixturesDir, 'behavior');
  let behaviorCount = 0;
  let behaviorFileCount = 0;
  let behaviorFailures = 0;
  const validateBehavior = ajv.getSchema(behaviorSchema['$id'] as string);
  if (!validateBehavior) {
    throw new Error('Behavior fixture schema was not registered');
  }
  try {
    const behaviorDomains = await readdir(behaviorDir);
    for (const domain of behaviorDomains) {
      const domainDir = join(behaviorDir, domain);
      let entries: string[];
      try {
        entries = await readdir(domainDir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const path = join(domainDir, entry);
        const fixturePath = relative(fixturesDir, path);
        let data: { _meta?: { executor?: string }; cases?: unknown[] };
        try {
          data = JSON.parse(await readFile(path, 'utf-8')) as typeof data;
        } catch (error: unknown) {
          console.log(`❌ ${fixturePath} (invalid JSON)`);
          console.log(`   → ${error instanceof Error ? error.message : String(error)}`);
          behaviorFailures++;
          continue;
        }

        if (!validateBehavior(data)) {
          console.log(`❌ ${fixturePath} (malformed behavior fixture)`);
          for (const error of validateBehavior.errors ?? []) {
            console.log(`   → ${error.instancePath}: ${error.message}`);
          }
          behaviorFailures++;
          continue;
        }

        const caseCount = data.cases!.length;
        behaviorCount += caseCount;
        behaviorFileCount++;
        console.log(
          `✅ ${fixturePath} (${caseCount} validated cases, executor: ${data._meta!.executor}; execution skipped — requires P-2)`,
        );
      }
    }
  } catch {
    // No behavior directory yet — that's fine
  }

  console.log();
  console.log(`Results: ${results.length - schemaFailures}/${results.length} contract fixtures passed`);
  if (behaviorCount > 0) {
    console.log(
      `⏭️  ${behaviorCount} validated behavioral cases across ${behaviorFileCount} file(s); loopback execution requires P-2`,
    );
  }

  if (schemaFailures + behaviorFailures > 0) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('Conformance runner crashed:', err);
  process.exit(1);
});
