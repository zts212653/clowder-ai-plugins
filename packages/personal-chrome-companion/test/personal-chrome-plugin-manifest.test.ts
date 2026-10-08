import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

import { validateManifest } from '@clowder-ai/plugin-contract';

const manifestPath = new URL('../plugin.yaml', import.meta.url);

function loadManifest(): Record<string, unknown> {
  return parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
}

test('plugin.yaml passes the frozen contract manifest validator', () => {
  const result = validateManifest(loadManifest());
  assert.equal(result.valid, true, JSON.stringify(result.valid ? [] : result.errors));
});

test('plugin.yaml declares the frozen runtime data directory and capabilities', () => {
  const manifest = validateManifest(loadManifest());
  assert.equal(manifest.valid, true);
  if (!manifest.valid) return;
  assert.equal(manifest.manifest.runtime?.transport, 'builtin');
  assert.equal(
    (manifest.manifest.runtime as { dataDirectory?: string }).dataDirectory,
    'personal-chrome-host',
  );
  const feature = manifest.manifest.features[0]!;
  assert.deepEqual([...feature.capabilities].sort(), ['cloud.conversation.host', 'data.directory']);
});

test('a cloud-conversation-host owned by a feature without cloud.conversation.host is rejected', () => {
  const candidate = loadManifest();
  const features = candidate.features as Array<Record<string, unknown>>;
  features[0] = {
    ...features[0]!,
    capabilities: ['data.directory'],
  };
  const result = validateManifest(candidate);
  assert.equal(result.valid, false);
  assert.ok(
    !result.valid &&
      result.errors.some(
        (error) =>
          error.keyword === 'capabilityRequired' &&
          error.message.includes('cloud.conversation.host'),
      ),
    JSON.stringify(result.valid ? [] : result.errors),
  );
});

test('the frozen row-action declaration matches contract beta.24 (row render, confirm, next)', () => {
  const manifest = validateManifest(loadManifest());
  assert.equal(manifest.valid, true);
  if (!manifest.valid) return;
  const field = manifest.manifest.configuration?.find(
    (entry) => entry.kind === 'operation',
  );
  assert.ok(field, 'authorization operation must be declared');
  const actions = field!.actions;
  const list = actions.find((action) => action.id === 'list');
  const revoke = actions.find((action) => action.id === 'revoke');
  const status = actions.find((action) => action.id === 'status');
  assert.equal(list?.render, 'status');
  assert.equal(revoke?.render, 'row');
  assert.ok(revoke?.confirm !== undefined && revoke.confirm.length >= 1 && revoke.confirm.length <= 200);
  assert.equal(revoke?.next, 'list');
  assert.equal(status?.render, 'status');
});
