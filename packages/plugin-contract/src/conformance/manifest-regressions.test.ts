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
) as {
  $id: string;
  'x-clowder-capability-policy'?: {
    signed?: { gate?: string; date?: string };
    firstPartyPreset?: {
      allowedLayers?: string[];
      visible?: boolean;
      revocable?: boolean;
    };
    defaultWhisperTargets?: string[];
    lifecycleCallbacks?: {
      semantics?: string;
      grantable?: boolean;
      revocable?: boolean;
    };
  };
};
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

test('capability policy records the G-0 signed grant defaults', () => {
  assert.deepEqual(schema['x-clowder-capability-policy'], {
    signed: { gate: 'G-0', date: '2026-07-15' },
    firstPartyPreset: {
      allowedLayers: ['L1'],
      visible: true,
      revocable: true,
    },
    defaultWhisperTargets: [],
    lifecycleCallbacks: {
      semantics: 'protocol-intrinsic',
      grantable: false,
      revocable: false,
    },
  });
});

test('protocol-intrinsic lifecycle fixture needs no lifecycle capability id', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        '../../fixtures/manifest/valid/protocol-intrinsic-lifecycle.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { features: Array<{ capabilities: string[] }> };

  assert.equal(ajv.getSchema(schema.$id)?.(fixture), true);
  assert.deepEqual(fixture.features.flatMap((feature) => feature.capabilities), []);
});
