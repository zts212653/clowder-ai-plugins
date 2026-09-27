import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseInteractionActionDraft } from './interaction-action.mjs';

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
}

test('draft wire accepts bounded Host-issued references and rejects raw target injection', () => {
  const valid = fixture('valid-action');
  assert.equal(parseInteractionActionDraft(valid).actionId, 'action-001');
  assert.throws(() => parseInteractionActionDraft(fixture('forged-target')), /unknown or missing/);
  assert.throws(() => parseInteractionActionDraft({ ...valid, confirmationHandle: '' }), /confirmationHandle/);
  assert.throws(() => parseInteractionActionDraft({ ...valid, operationDigest: '0' }), /operationDigest/);
});
