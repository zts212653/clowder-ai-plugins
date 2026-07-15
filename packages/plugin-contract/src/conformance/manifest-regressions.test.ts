import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const Ajv = require('ajv/dist/2020') as new (options: {
  allErrors: boolean;
  strict: boolean;
}) => {
  addSchema(schema: object, id: string): void;
  getSchema(ref: string): ((data: unknown) => boolean) | undefined;
};

const schema = JSON.parse(
  readFileSync(new URL('../schemas/manifest.schema.json', import.meta.url), 'utf8'),
) as { $id: string };
const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addSchema(schema, schema.$id);

function validate(definition: string, value: unknown): boolean {
  const validator = ajv.getSchema(`${schema.$id}#/$defs/${definition}`);
  assert.ok(validator, `missing schema definition ${definition}`);
  return validator(value);
}

test('external runtimes require a non-empty entrypoint', () => {
  assert.equal(validate('RuntimeDeclaration', { transport: 'stdio' }), false);
  assert.equal(validate('RuntimeDeclaration', { transport: 'ipc' }), false);
  assert.equal(
    validate('RuntimeDeclaration', { transport: 'stdio', entrypoint: '' }),
    false,
  );
  assert.equal(
    validate('RuntimeDeclaration', { transport: 'ipc', entrypoint: 'dist/plugin.js' }),
    true,
  );
});

test('builtin runtimes do not require an entrypoint', () => {
  assert.equal(validate('RuntimeDeclaration', { transport: 'builtin' }), true);
});
