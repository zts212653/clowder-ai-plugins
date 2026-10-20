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
const addFormats = require('ajv-formats') as (ajv: object) => void;

const pluginMetadataSchema = JSON.parse(
  readFileSync(new URL('../schemas/plugin-metadata.schema.json', import.meta.url), 'utf8'),
) as { $id: string };
const schema = JSON.parse(
  readFileSync(new URL('../schemas/manifest.schema.json', import.meta.url), 'utf8'),
) as { $id: string };
const signalSchema = JSON.parse(
  readFileSync(new URL('../schemas/signal.schema.json', import.meta.url), 'utf8'),
) as { $id: string };
const messagingSchema = JSON.parse(
  readFileSync(new URL('../schemas/messaging.schema.json', import.meta.url), 'utf8'),
) as { $id: string };
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(pluginMetadataSchema, pluginMetadataSchema.$id);
ajv.addSchema(signalSchema, signalSchema.$id);
ajv.addSchema(messagingSchema, messagingSchema.$id);
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

test("render 'rows' binds OperationActionResult.data to OperationRows", () => {
  assert.equal(validate('OperationActionResult', { render: 'rows', data: { rows: [] } }), true);
  assert.equal(validate('OperationActionResult', { render: 'rows', data: 42 }), false);
  assert.equal(validate('OperationActionResult', { render: 'status', data: 42 }), true);
});

test('cloud conversation source ids reference the shared MessageId definition', () => {
  const defs = (schema as unknown as { $defs: Record<string, { properties?: Record<string, { $ref?: string }> }> }).$defs;
  const messageIdRef = 'https://clowder-ai.dev/schemas/messaging/v0.1#/$defs/MessageId';

  assert.equal(defs.CloudConversationAppendMessageInput.properties?.idempotencyKey?.$ref, messageIdRef);
  assert.equal(defs.CloudConversationReturnCursor.properties?.sourceMessageId?.$ref, messageIdRef);
  assert.equal(defs.CloudConversationAssistantReturn.properties?.sourceMessageId?.$ref, messageIdRef);
  assert.equal(defs.CloudConversationAckInput.properties?.sourceMessageId?.$ref, messageIdRef);
});
