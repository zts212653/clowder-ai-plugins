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
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BehaviorFixture } from '../generated/contract.generated.js';
import { validateMessagingSemantics } from '../validation/messaging-semantic.js';
import {
  executeBehaviorCase,
  type BehaviorAdapter,
} from './behavior-executor.js';
import { MessagingLoopbackAdapter } from './messaging-loopback-adapter.js';

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
// Runner
// ---------------------------------------------------------------------------

export interface ConformanceReport {
  readonly contractFixtures: {
    readonly passed: number;
    readonly total: number;
  };
  readonly behaviorCases: {
    readonly passed: number;
    readonly total: number;
  };
  readonly failures: readonly string[];
}

export interface ConformanceOptions {
  readonly behaviorAdapters?: Readonly<Record<string, () => BehaviorAdapter>>;
  readonly write?: (line: string) => void;
}

const defaultBehaviorAdapters = {
  loopback: () => new MessagingLoopbackAdapter(),
} satisfies Readonly<Record<string, () => BehaviorAdapter>>;

function isMissingDirectory(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

export async function runConformance(
  options: ConformanceOptions = {},
): Promise<ConformanceReport> {
  const fixturesDir = join(PKG_ROOT, 'fixtures');
  const schemasDir = join(PKG_ROOT, 'src', 'schemas');
  const write = options.write ?? console.log;
  const behaviorAdapters = options.behaviorAdapters ?? defaultBehaviorAdapters;
  const failures: string[] = [];

  write('🔍 Conformance runner — @clowder-ai/plugin-contract');
  write(`   Fixtures: ${fixturesDir}`);
  write(`   Schemas:  ${schemasDir}`);
  write('');

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

  const results: ValidationResult[] = [];
  for (const fixture of fixtures) {
    results.push(await validateFixture(ajv, fixture, schemas));
  }

  // Report schema fixtures
  for (const result of results) {
    const icon = result.passed ? '✅' : '❌';
    const expect = result.fixture.validity === 'valid' ? 'should pass' : 'should fail';
    write(`${icon} ${result.fixture.relativePath} (${expect})`);
    if (!result.passed) {
      const errors = result.errors ?? ['fixture did not meet its expected validity'];
      failures.push(
        ...errors.map((message) => `${result.fixture.relativePath}: ${message}`),
      );
    }
    if (result.errors && !result.passed) {
      for (const err of result.errors) {
        write(`   → ${err}`);
      }
    }
  }

  // Validate and execute behavioral fixtures through registered adapters.
  const behaviorDir = join(fixturesDir, 'behavior');
  let behaviorTotal = 0;
  let behaviorPassed = 0;
  let behaviorFileCount = 0;
  const validateBehavior = ajv.getSchema(behaviorSchema['$id'] as string);
  if (!validateBehavior) {
    throw new Error('Behavior fixture schema was not registered');
  }

  let behaviorDomains: string[] = [];
  try {
    behaviorDomains = await readdir(behaviorDir);
  } catch (error: unknown) {
    if (!isMissingDirectory(error)) {
      throw error;
    }
  }

  for (const domain of behaviorDomains) {
    const domainDir = join(behaviorDir, domain);
    let entries: string[];
    try {
      entries = await readdir(domainDir);
    } catch (error: unknown) {
      if (isMissingDirectory(error)) {
        continue;
      }
      throw error;
    }

    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const path = join(domainDir, entry);
      const fixturePath = relative(fixturesDir, path);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(path, 'utf-8'));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        write(`❌ ${fixturePath} (invalid JSON)`);
        write(`   → ${message}`);
        failures.push(`${fixturePath}: invalid JSON: ${message}`);
        continue;
      }

      if (!validateBehavior(parsed)) {
        write(`❌ ${fixturePath} (malformed behavior fixture)`);
        const errors = validateBehavior.errors ?? [];
        for (const validationError of errors) {
          const message = `${validationError.instancePath}: ${validationError.message}`;
          write(`   → ${message}`);
          failures.push(`${fixturePath}: ${message}`);
        }
        if (errors.length === 0) {
          failures.push(`${fixturePath}: malformed behavior fixture`);
        }
        continue;
      }

      const data = parsed as BehaviorFixture;
      const caseCount = data.cases.length;
      behaviorTotal += caseCount;
      behaviorFileCount++;
      const createAdapter = behaviorAdapters[data._meta.executor];
      if (!createAdapter) {
        const message = `unsupported behavior executor ${data._meta.executor}`;
        write(`❌ ${fixturePath} (${message})`);
        failures.push(`${fixturePath}: ${message}`);
        continue;
      }

      let filePassed = 0;
      for (const behaviorCase of data.cases) {
        try {
          const report = await executeBehaviorCase(behaviorCase, createAdapter());
          if (report.passed) {
            behaviorPassed++;
            filePassed++;
          } else {
            failures.push(
              ...report.failures.map(
                (failure) => `${fixturePath}/${report.id}: ${failure}`,
              ),
            );
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push(`${fixturePath}/${behaviorCase.id}: adapter threw: ${message}`);
        }
      }

      write(`${filePassed === caseCount ? '✅' : '❌'} ${fixturePath}`);
      write(
        `   ${filePassed}/${caseCount} ${data._meta.executor} behavior cases executed`,
      );
    }
  }

  const contractPassed = results.filter(({ passed }) => passed).length;
  write('');
  write(`Results: ${contractPassed}/${results.length} contract fixtures passed`);
  if (behaviorTotal > 0) {
    write(
      `         ${behaviorPassed}/${behaviorTotal} behavior cases executed across ${behaviorFileCount} file(s)`,
    );
  }

  return {
    contractFixtures: { passed: contractPassed, total: results.length },
    behaviorCases: { passed: behaviorPassed, total: behaviorTotal },
    failures,
  };
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  runConformance()
    .then((report) => {
      if (report.failures.length > 0) {
        process.exitCode = 1;
      }
    })
    .catch((err: unknown) => {
      console.error('Conformance runner crashed:', err);
      process.exitCode = 1;
    });
}
