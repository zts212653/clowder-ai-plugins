import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateSignalDeclaration,
} from '../index.js';

const declaration = {
  type: 'feishu.meeting_artifact.generated.v1',
  schemaRef: 'schemas/feishu-meeting-artifact.v1.schema.json',
  epistemicStatus: 'observation',
  privacyClass: 'content-adjacent',
  sourceClass: 'remote-service',
} as const;

test('accepts the first real remote-service signal declaration', () => {
  assert.deepEqual(validateSignalDeclaration(declaration), {
    valid: true,
    value: declaration,
    errors: [],
  });
});

test('rejects forbidden classes, user intent, and non-package schema refs', () => {
  const invalid = [
    { ...declaration, privacyClass: 'av-raw' },
    { ...declaration, privacyClass: 'input-raw' },
    { ...declaration, sourceClass: 'av-capture' },
    { ...declaration, sourceClass: 'input-hardware' },
    { ...declaration, epistemicStatus: 'user_intent' },
    { ...declaration, schemaRef: 'https://attacker.example/schema.json' },
    { ...declaration, schemaRef: 'schemas/../secret.schema.json' },
  ];

  for (const value of invalid) {
    assert.equal(validateSignalDeclaration(value).valid, false, JSON.stringify(value));
  }
});
